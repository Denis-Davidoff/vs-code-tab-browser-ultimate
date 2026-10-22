# AI Browser chat in Google Chrome: research

Original research date: 2026-10-21.

Implementation updates: the host API adapter, state subscription, local bridge and
installable Chrome side panel are implemented. The shared renderer/CSS, editor
theme, sending, queue, Stop, approvals, model selection and main settings are
connected. Exclusive ownership transfer and an independent backend remain future
work. See [installation instructions](../chrome-extension/README.md).

2026-10-22: quick pairing adds automatic local editor discovery and **Allow** /
**Deny** controls in editor chat panels. Credentials are issued only after approval;
manual code exchange remains a fallback.

## Recommendation

Start with a Manifest V3 extension displaying one conversation in a side panel
without a tab strip. VS Code owns Claude, Codex and Gemini processes, history,
settings and tools. Chrome is another interface; the CLI process stays in place.

Here, “this chat” means this repository's AI Browser chat. Moving arbitrary
ChatGPT or official Codex UI conversations requires separate interface research.

## Existing foundations

| Foundation | File | Relevance to Chrome |
| --- | --- | --- |
| DOM interface | `preview-src/chat.ts` | Reuse rendering, Markdown, composer, settings and approvals |
| Typed messages | `src/chat/chatProtocol.ts` | Shared `HostToView` / `ViewToHost` contracts |
| State and commands | `src/chat/chatView.ts` | Separate `_state`, `_receive`, `_postMessage` from webviews |
| Live conversation | `src/chat/chatTab.ts` | `ChatTab` owns sessions, attachments and queues; `StoredChat` stores history and `ref` |
| Panel transfer | `src/chat/chatView.ts` | `_moveTabInto` preserves session, draft, attachments, skill runs and annotations |
| Transfer checks | `src/chat/chatTabMove.test.ts` | Cover running-session preservation and failed-open rollback |
| Agents | `src/chat/{codex,claude,gemini}Agent.ts` | Remain in Node / VS Code |
| Local server | `src/mcp/mcpServer.ts`, `mcpProtocol.ts` | Existing loopback/authentication patterns; MCP does not replace the UI protocol |
| Chrome control | `src/browser/chromeBrowser.ts` | Coordinate the existing CDP path with the Chrome instance hosting the UI |
| Styling | `media/chat.css`, `esbuild.webview.mts` | Shared UI build with portable theme tokens |

At research time the renderer had approximately 8,400 lines, the controller 5,600
and CSS 5,100. Copying these would quickly diverge; share components and adapters.

## Proposed initial architecture

Chrome side panel → authenticated local UI bridge → VS Code chat controller →
existing agent backends and tools.

1. Extract a `ChatSurface` / transport adapter for events, commands, connections,
   disconnection and capabilities. The webview becomes the first adapter.
2. Replace direct `acquireVsCodeApi()` use with an injected host adapter. Chrome
   needs independent draft storage and event delivery.
3. Add a dedicated loopback UI endpoint. HTTP + SSE and command POSTs were initial
   candidates; WebSocket is an alternative after checking dependencies. Preserve
   existing MCP origin checks. The implemented bridge uses conditional polling.
4. Pair explicitly with an editor window/workspace; multiple windows can coexist.
5. Build Manifest V3, side panel, service worker and local shared UI assets.

### Future transfer in both directions

Potential actions: **Continue in Chrome** and **Return to VS Code**.

- Keep a stable conversation ID and the same agent session.
- Connect the destination and acknowledge its snapshot, draft and attachment IDs
  before changing input ownership. Failed transfers leave the source usable.
- A single input owner can use a generation/lease to reject stale sends or approvals.
- Agent work may continue during transfer. Pending Git operations, recordings and
  message launches may delay transfer, as in existing panel movement.
- Closing the side panel or losing transport must not automatically invoke
  `ChatTab.close()`; define a return-to-editor policy.

The original `_moveTabInto` expects a `ChatViewProvider`, `destination._view` and
shared `_services`. It is a useful model rather than a ready interprocess transfer
mechanism. The original `_bindView` stops sessions when the webview closes; Chrome
requires a separate lifecycle.

### Settings and recovery

- VS Code remains the source of settings; Chrome receives snapshots and changes.
- Validate changes using existing host code. Separate global, workspace and chat
  settings; approval policy stays bound to the workspace without increased privileges.
- Use settings revisions, event sequences and unique command IDs. Retries must
  not launch duplicate turns or Git commands.
- Reconnect with an authoritative snapshot; version drafts separately to avoid
  overwriting newer text during recovery.
- Keep OAuth/CLI credentials, MCP tokens and secret storage out of Chrome.
- Chrome Sync is not VS Code storage or suitable chat history storage. Its research-time
  quota was approximately 100 KB overall and 8 KB per item.

### Trust boundary

The bridge reaches agents with local tools. Bind only to loopback, use credentials
separate from MCP, require pairing and extension-origin checks, validate runtime
messages, bound request sizes, allowlist capabilities and support revocation.
TypeScript declarations alone do not validate JSON. Pages and content scripts must
never receive bridge credentials. Adapt webview file/icon/attachment URLs without
exposing the arbitrary local filesystem over HTTP.

## Chrome capabilities and constraints

- Side Panel API keeps chat beside the current page with one panel path across navigation.
- Initially VS Code must stay running; Chrome does not launch CLI processes or gain Node APIs.
- Native Messaging is a future option for an installed daemon shared by Chrome and
  VS Code. It requires an installer, native host registration and removal of VS Code API dependencies.
- The user's regular Chrome and the CDP backend may use different profiles. Opening
  a side panel does not itself grant page control. Add `activeTab`, `scripting` or
  debugger permissions according to each feature's actual needs.
- SSH/container support needs separate verification because browser localhost differs
  from a remote extension host. The first target is a local IDE window.

## Implementation stages and acceptance

1. Shared surface adapter without webview regressions.
2. Read-only panel with pairing, conversation selection, history and live replies.
3. Sending, draft/attachment transfer, Stop, questions, approvals and future ownership transfer.
4. Settings, reconnect and repeat delivery.
5. Active Chrome page integration, then an independent daemon if needed.

The original transfer target was VS Code → Chrome → VS Code without a new CLI
session or lost drafts, queues or attachments. Replies should continue streaming,
approvals happen once, reconnect never duplicate sends, foreign origins or
credentials never obtain access, and closing Chrome's panel never kill a turn.
Exclusive transfer remains distinct from the implemented mirror.

Validate with existing movement tests, integration tests for ownership, rollback,
deduplication and validation, plus unpacked Chrome testing with reload, panel
closure, multiple IDE windows and host restart.

## Reference links from the original research

- [Chrome Side Panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome Storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)

The original App Server research identified `thread/resume`, streaming and approvals
as support for resumable backend conversations, without implying third-party UI
state transfer. Direct WebSocket app-server transport was documented as experimental;
a bridge over existing backends preserves all three agents and AI Browser settings.
