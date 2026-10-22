# AI Browser Privacy Policy

Last updated: October 22, 2026

## Scope

This policy describes the AI Browser Chrome extension and its connection to the
AI Browser extension for VS Code, maintained by Denis Davydov
([Denis-Davidoff on GitHub](https://github.com/Denis-Davidoff)).

The Chrome extension provides a side-panel interface to an AI conversation running
in a local VS Code instance. You approve the connection in VS Code.

## Data the extension handles

- **Conversations:** messages, replies, approval responses, chat settings, usage and
  context information, and attachments you provide.
- **Website context:** tab URLs and titles, selected element text and metadata,
  annotations and their associated pages, and screenshots you request. Enabled
  annotations synchronize while the side panel is connected and can be read or
  changed by the agent through the connected VS Code instance.
- **Recordings:** screen or tab video you choose to record through Chrome's
  sharing chooser. Recordings may include visible personal information and user
  actions. The resulting recording can be attached to the conversation.
- **Connection information:** local connection addresses, authorization credentials
  and identifiers used to reconnect to the VS Code instance you approved.
- **Development context:** working folder information, skills, Git branches,
  commits and repository information displayed or requested through VS Code.

Messages, selected pages and attachments may contain personal or sensitive
information. Share only information you intend to provide to your conversation
and its configured agents and tools.

## How data is used and shared

Data is used to provide the chat, page-context, annotation, attachment and related
development features you use. The Chrome extension exchanges this data with your
approved VS Code instance over an authenticated loopback connection on the same
computer.

VS Code runs the configured agents and tools. Conversation content, attachments
and relevant context may be sent to the AI providers and other services used by
those agents and tools. Local agents may process data on your computer. External
services, including GitHub when you use repository features, handle data according
to their own policies. Review your agent, tool and provider configuration to
understand which services receive your data.

The Chrome extension does not send chat or page content to a developer-operated
collection server. It does not include advertising or analytics tracking, build
browsing-history profiles, sell user data, or use data for creditworthiness or
lending decisions. Data is used and transferred only to provide the user-facing
features described here, not for unrelated advertising or marketing.

## Storage and retention

The Chrome extension uses Chrome session storage for drafts, pending messages,
attachment and annotation state, interface settings and the current connection.
Session storage can survive closing and reopening the side panel and is cleared
when the browser session ends or the extension is disabled, reloaded or updated.
An authorization credential and reconnection identifiers are stored in Chrome
local storage so the approved connection can resume after restarting Chrome.
Connection credentials are not stored in Chrome Sync.

Data sent to VS Code, including chat history and attachments, can remain in local
application storage independently of the Chrome extension. Data sent to external
providers is subject to their retention policies and your account settings. There
is no single automatic deletion period across these separate locations.

## Your controls

- Use **Disconnect** in the Chrome side panel to forget its saved reconnection
  credential and end that connection. Disconnecting does not delete existing
  conversations, attachments or all saved drafts.
- Restrict website access in Chrome's extension settings. Page-context features
  may not work on sites where access is restricted.
- Stop a recording using the extension's recording controls or Chrome's sharing
  controls.
- Remove annotations and draft attachments using their available controls.
- Uninstall the Chrome extension to remove its Chrome extension storage. This
  does not delete copies already stored in VS Code or received by other services.
- Manage local conversation history and files in VS Code and its application
  storage, and use your provider's controls for data held by that provider.

## Policy changes and contact

Updates to this policy will be published on this page with a revised date.
Material changes to data practices must also be reflected in the store disclosures
and relevant product notices.

For privacy questions or deletion guidance, contact the maintainer through the
[project issue tracker](https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/issues).
Issues are public: do not include private page content, chat transcripts,
credentials or other sensitive information.
