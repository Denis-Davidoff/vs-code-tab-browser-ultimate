# Linked chats over MCP

Temporarily disabled by `chatConnectionsEnabled` in `src/chat/core/chatFeatures.ts`.
The composer menu and connection chips are hidden, and linked-chat and worker MCP
tools are unavailable. Saved connections and conversations are preserved. The
documentation below describes the feature when enabled.

In VS Code, use **+ → Connect a chat…** to select an open or saved conversation
and grant either read access or read and add notes. Connections appear above
the composer; click a connection to change its access, or its × to revoke it.
Chrome and Exchange show existing connections; grants are managed in VS Code.

Connecting B in A lets A access B. It grants neither B access to A nor A access
to B's connections. Only the authenticated calling conversation identifies the
source; chat IDs are resource identifiers, never capability tokens. A general
MCP token cannot use these tools. Every call, retry and cursor continuation
checks the caller and its current grant. Notes and grant changes are serialized.

## Tools

| Tool | Parameters in addition to pagination |
| --- | --- |
| `chat_list` | `fields`, `changedSince` (Unix milliseconds) |
| `chat_get_metadata` | `chatIds`, optional `fields` |
| `chat_read_messages` | `chatId`, optional `messageIds`, `aroundMessageId`, `contextMessages`, inclusive `from`/`to` visible-history indexes, `roles`, `kinds`, `order`, `detail`, `maxMessageChars`, `textOffset` |
| `chat_search` | Literal case-insensitive `query`, optional `chatIds`, `roles`, `kinds`, `order`, `detail`, `maxMessageChars` |
| `chat_add_note` | `chatId`, `text` (up to 20000 characters), `requestId` (up to 200 characters) |

Pagination parameters are `limit` (1–100, default 20 or 10 for search),
`maxBytes` (2048–131072, default 24576), `cursor`, and `ifRevision`.
`maxBytes` bounds the UTF-8 compact JSON text content, excluding MCP framing.
Repeat the same query parameters with `nextCursor`. A changed selection or
changed grant invalidates its cursor and requires restarting the selection.
`ifRevision` returns a small `notModified` response when applicable.

`detail` is `index` (previews), `text` (default), or `full` (also saved tool
input/output and result text/JSON). Thinking, approval requests and binary
attachment bodies are excluded at every level. Search uses the selected detail;
use `full` explicitly to search saved tool output.

Each selected record includes its chat/message IDs, visible-history index,
role, kind, timestamp when known, and text. `maxMessageChars` defaults to 2000
and accepts 64–20000. `textNextOffset` identifies unread text. Continue it using
`messageIds: [messageId]`, the same `detail`, and `textOffset: textNextOffset`.
Offsets are UTF-16 string offsets, not byte offsets. To expand a search result,
read its `messageId` from the beginning or use `aroundMessageId` for neighbors.

Responses include a selection revision and fetch time. `truncated` describes
response pagination or clipped text; `historyCompleteness` independently reports
`full`, `partial`, or `unknown` for the application's captured history. It makes
no claim about additional provider-side history. Counts cover available messages
only. Unknown saved models and message dates are null. Search misses cannot
establish absence from incomplete history.

## Persistence and notes

Grants live in workspace state under `aiBrowser.chat.links`. Chat history keeps
stable message IDs, history completeness and note receipts. Legacy missing or
duplicate IDs receive deterministic IDs before storage truncation. Existing
history limits remain: 50 saved chats, up to 400 entries per chat, with long
stored bodies clipped. A link does not pin history against eviction. Missing
targets appear unavailable in the composer and cannot be read or written.

Notes are notice entries with server-assigned source chat, author and time;
they never invoke the target AI. The next user turn tells the target AI that
notes are available through `chat_read_messages`. Cross-chat text is reference
data, not a user instruction. A successful repeated `requestId` returns the
original message ID without adding a duplicate, including after message pruning;
reusing it for different text is an error. Retries still require current write
permission. Revocation cannot remove content an AI has already read.

## Owned workers and tasks

A conversation can create background worker chats through MCP. Ownership is
attached to conversation IDs, not UI tabs. A normal linked chat, even with
read-and-add access, is never a manageable worker. Only its direct creator can
manage a worker, and only while its directed connection remains read-and-add.
Removing or downgrading the connection revokes management; it does not erase
ownership or automatically stop an assignment already running.

| Tool | Purpose |
| --- | --- |
| `chat_list_models` | Page available installed agents, exact model IDs and supported effort levels; optional `agent`, `limit` (1–100), `offset` |
| `chat_create` | Create an idle worker: `requestId`, `title`, `agent`, `model`; optional `effort`, `purpose` |
| `chat_configure` | Update an idle worker's `model`, `effort`, `title` or `purpose` |
| `chat_reset_context` | Clear an idle worker's captured history and provider session; optionally change `agent`, `model`, `effort` |
| `chat_send_task` | Persist and dispatch an assignment using `text`; optional `resetContext: true` starts it with clean context in the same worker; return a `taskId` immediately |
| `chat_get_task` | Read the latest task, or select an older task using `taskId` |
| `chat_stop_task` | Cancel the active assignment using the existing chat Stop behavior |

Worker mutations require a `requestId`; operations after creation also require
the worker's `chatId`. Requests with the same ID and arguments are idempotent,
including across restarts and context resets. Reusing an operation ID with
different arguments is an error. Retry responses may contain the original
acknowledgement; use `chat_get_task` for the current execution state.

For example:

```json
{"tool":"chat_create","arguments":{"requestId":"review-worker-1","title":"Reviewer","agent":"codex","model":"<ID from chat_list_models>","purpose":"Review proposed changes for bugs"}}
```

Then send the assignment with `chat_send_task`, poll `chat_get_task`, and use
`chat_read_messages` to retrieve the answer. `messageId` in task metadata points
to its dispatched prompt; `chatState` indicates whether an approval is waiting.
Task states are `starting`, `running`, `completed`, `failed`, `cancelled` and
`interrupted`. A runtime lost during an active task is reported as interrupted
when its status is queried; acknowledged tasks are never automatically replayed.
The parent receives an informational completion notice when it is open; it is
not automatically prompted to run another turn.

To reuse a worker for an independent assignment, pass `resetContext: true`:

```json
{"chatId":"<existing worker ID>","requestId":"independent-task-2","text":"Handle this new assignment","resetContext":true}
```

The same chat and tab are reused, retaining agent, model, role, folder, rights
and explicit resource bindings. History and provider resume state are cleared
before dispatch; `generation` increments and `contextCleared` is returned. The
reset and new task receipt are persisted together. Retrying the same request
never clears the new context again. Omitting the flag (or setting it to false)
continues the existing context. Only an idle owned worker can be reset this way.
As with a standalone reset, workspace files and old task metadata remain. If
dispatch fails after the reset was saved, the context remains cleared and the
task status reports the failure; a retry does not replay it automatically.

Creation uses an installed agent and an exact available model. Each worker
persists its own model and effort; it never updates global model preferences.
Unavailable choices produce errors instead of silently choosing another model.
Changing the agent requires resetting context; changing the model alone retains
the provider conversation. Its reusable purpose is supplied on subsequent turns.

A reset keeps the chat ID, ownership, title, working folder, role, explicit
browser/terminal bindings and operation
receipts; it increments `generation`, clears transcript, usage and provider
resume state, and disposes the old session. Workspace files remain. Old task
metadata is retained for status and deduplication, but old task answers are
removed from captured history. Busy or paused workers refuse task dispatch;
busy workers refuse configuration and reset. Stop and wait for the worker to
become idle before resetting it.

Workers inherit the parent's working folder and reference repositories. They
receive no browser/terminal pins and no automatic access back to their parent.
They share workspace files: coordinate edits between agents. Normal tool
approval policies still apply. Creation, configuration, reset, task dispatch
and cancellation are classified as **Chat control**; model discovery and task
status are reads. Workers open in the background and can reopen from saved
history when another task is sent.

Limits: eight children per owner, three ownership levels below a user chat,
the existing UI tab limit, 512 distinct management operations per worker,
50000 characters per task, 4000 per purpose and 80 per title. The existing
50-chat history retention limit still applies to closed workers. Model lists
are capped at approximately 24 KiB of compact JSON per response.

Deferred: artifact catalog tools, incremental change feeds and generated
summaries.
