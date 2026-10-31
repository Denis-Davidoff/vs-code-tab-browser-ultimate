# Rich chat events and results

The shared protocol renders notifications, progress, plans, structured results, JSON
and anchored citations in VS Code, Chrome and Exchange. Provider adapters normalize
native events; conversation-scoped MCP tools also expose these interfaces to Claude,
Codex and the other connected providers. No presentation action executes model-supplied
JavaScript or shell commands.

## Tools

All tools require the caller's conversation capability. An argument cannot select
another conversation. Reuse a card's `id` to update it.

| Tool | Arguments and behavior |
| --- | --- |
| `chat_notify` | `{id?, text, level?, reason?, related?, actions?}`; levels are `info`, `warning`, `error`. The host records the first publication time. Updating an ID preserves that time. |
| `chat_progress` | `{id, title, stage?, percent?, status?, cancel?, related?}`; percent is 0–100, null means indeterminate. Status is `running`, `done`, `failed` or `cancelled`. The same card shows elapsed time. |
| `chat_update_plan` | `{id, title?, steps, related?}`; each step has `{id?, text, status}`. Status is `pending`, `inProgress`, `done` or `cancelled`; at most one current step is accepted. |
| `chat_present_json` | `{id?, title?, value}`; value remains actual JSON, with a collapsible tree, search, Copy value and Copy JSON. |
| `chat_present_result` | `{id?, title?, blocks}`; publishes ordered text, JSON, image, file and link blocks. |
| `chat_cite` | `{messageId?, text?, citations}`; publishes a new answer with bound citations, or updates citations on an existing assistant message. |

Claude Code uses MCP's `mcp__ai-browser__` tool prefix. The chat supplies these tool
instructions in each prompt. Publication tools return the displayed card/message ID;
an additional copy of the answer is unnecessary.

## Notifications and relationships

A relation is `{messageId?, toolId?}`. Reveal actions scroll to and expand a message
or tool in the currently loaded conversation. If it is outside the loaded history,
the interface explains that earlier messages need to be loaded. Supported actions:

```json
[
  {"label":"Help","kind":"link","url":"https://example.com/help"},
  {"label":"Copy diagnostic","kind":"copy","text":"Diagnostic text"},
  {"label":"Show tool","kind":"reveal","target":{"toolId":"tool-call-id"}}
]
```

Link actions accept HTTP(S) URLs without credentials; they use the chat's existing
link routing. Copy and reveal actions stay local to the viewer. Notification text,
reasons, JSON values and plan steps are displayed as text.

## Progress and cancellation

A new progress ID starts its clock; subsequent updates preserve the start time.
Omitted values preserve previous fields; `percent:null` switches to indeterminate.
Final status records an end time. Related native tool completion settles its progress.
Turn-bound progress finishes with its turn; interrupted turns cancel unfinished plan
steps. A stored running progress card settles as cancelled when restored from history.

`cancel:{}` offers **Stop current turn**. `cancel:{agentId:"row-id"}` offers **Stop
agent**, using the backend's existing agent-stop operation. There is no generic
promise that an individual tool call can be interrupted. Only advertise cancellation
with the appropriate scope. A user click requests cancellation, disables repeated
requests and waits for the backend outcome. Remote commands validate the displayed
conversation before reaching that operation.

## Structured results

```json
{
  "title":"Result",
  "blocks":[
    {"type":"text","text":"Completed"},
    {"type":"json","value":{"count":42,"enabled":false}},
    {"type":"image","mimeType":"image/png","base64":"..."},
    {"type":"file","name":"report.pdf","base64":"..."},
    {"type":"link","title":"Reference","url":"https://example.com"}
  ]
}
```

Native MCP results from Claude and Codex retain typed blocks and `structuredContent`.
Unrecognized content blocks remain available as JSON rather than disappearing during
text conversion. Plain short text results retain their compact legacy presentation.
Image/file bytes are archived and replaced by references before history is saved.
Native image signatures and base64 are validated; binaries share the existing 4 MB
per-file limit and bounded snapshot transport. Invalid attachments produce an explicit
explanation while the other blocks remain visible. Files use the same user-initiated
download routing as other [chat artifacts](chat-visualizations.md).

JSON children are built on expansion, with 100 children per batch. Search shows up to
100 matching paths; the full value remains available through Copy JSON. Deeply nested
values remain available through copying even when the tree's nesting limit is reached.
Tool status changes preserve JSON expansion and search state.

## Anchored citations

For a new answer, supply its text and citations together:

```json
{
  "text":"The result contains 42 items.",
  "citations":[
    {"quote":"42 items","label":"1","target":{"type":"url","url":"https://example.com/reference"}}
  ]
}
```

A quote must match exactly once. For repeated fragments, supply `start` and `end`
UTF-16 offsets in the raw message text instead. Citations use the same offsets as
JavaScript string slicing, including Markdown syntax. Targets are HTTP(S) URLs,
absolute files with an optional positive line number, or message/tool IDs within
this conversation. Foreign message IDs, invalid ranges and executable URL schemes
are refused. A cited assistant answer keeps a stable message ID and its full text
in stored history so that offsets remain valid.

The renderer places numbered controls beside the cited fragment and lists its quote
below the answer. Markdown code fences retain clean copied code; a citation into a
fenced block remains accessible in the source list. File opening obeys the existing
surface restrictions. Source display is not source verification.

## Provider adapters and validation

Codex's `turn/plan/updated`, `item/mcpToolCall/progress`, warning notifications and
multipart tool completions are normalized by `agentProtocol.ts`. Plan/progress shapes
were checked against TypeScript generated by the locally installed `codex app-server`.
Claude Code's `TodoWrite` messages update a shared plan card; multipart `tool_result`
blocks feed the same renderer. The MCP tools cover manual progress, notifications,
plans, results and citations for either provider.

The browser integration probe exercises notifications and actions, determinate and
indeterminate progress, cancellation routing, stable cards, plan updates, real typed
tool output, JSON expansion/search/copy and URL/file/tool citations under the chat CSP.
Protocol tests cover both providers and history restoration, including closing a tab
while binary results archive and discarding a conversation while a result is queued.

```sh
npm run compile
npm run typecheck
node --test src/chat/richProtocol.test.ts src/chat/visualizationIntegration.test.ts
node scripts/test-visualizations-browser.mjs
```
