# Session host migration and AHP prototype

The first migration milestone separates published conversation state from the
selected UI tab. Execution still belongs to `ChatTab` and VS Code's extension
host. Closing the last owning view still stops its agents. This milestone does
not introduce a daemon, cloud execution, automations or a live canvas bridge.

## Implemented boundaries

- `src/chat/core/sessionHost.ts`: immutable conversation snapshots, pure reducer,
  ordered actions, bounded replay, snapshot fallback, subscriptions and a narrow
  optional control adapter. No runtime dependency on VS Code or a provider.
- `ChatViewProvider._publishSessions`: feeds all open conversations across the
  shared sidebar/editor panels into one in-process host at the existing coalesced
  state publication interval while an observer is attached. First-observer
  attachment bootstraps the current state. Without observers the experimental
  bridge does no history cloning or serialization. Moving a tab preserves identity.
  Removal from all views removes the published session. Last-view disposal clears
  the host. Existing Chrome and Exchange transports remain in use.
- `src/chat/core/ahpPrototype.ts`: a transport-free experiment using AHP JSON-RPC
  lifecycle names and explicitly private extension channels/actions/commands.

`SessionState` contains conversation ID, title, agent, directory, running state,
entries and pending sends. UI selection, theme, browser/terminal transport,
connection credentials and the artifact archive are outside this state. Entries
can still contain attachment data; snapshots are sensitive conversation data.
The snapshot is a migration projection, not yet the source of runtime mutations.

Replay retains at most 256 events and 2 MiB of serialized event data by default.
Streaming updates carry an entry tail starting at the first changed entry, rather
than the entire conversation. Larger events evict replay and clients recover via
snapshots. Current conversation state is retained independently of replay limits.
Clients apply events in server sequence order; sequence gaps can belong to other
channels. A new host instance requires fresh initialization, never reuse an old
host's cursor. Replay and deduplication are in-memory, not crash recovery.

## AHP experiment: explicit compatibility limits

References checked for this prototype:

- [AHP lifecycle](https://microsoft.github.io/agent-host-protocol/specification/lifecycle)
- [AHP extension namespaces](https://microsoft.github.io/agent-host-protocol/specification/overview)
- [AHP versus ACP](https://microsoft.github.io/agent-host-protocol/guide/ahp-and-acp)

This is **not a conformant AHP 1.0 host or a VS Code Agents endpoint**. Negotiating
the `1.0.0` envelope in this experiment does not implement the standard ChatState,
SessionState, catalog, tool-call reducer or interoperability requirements. The
initialization result advertises `ai-browser.profile: ai-browser.session.v1` and
`ai-browser.standardChat: false` under `_meta`. Only a client explicitly built for
this private profile can use it. There is no network listener or public API.

The root is `ahp-root://` with an empty standard agent list. Conversation channels
use `x-ai-browser-session:/<encoded-id>`. Snapshot state is our `SessionState`.
Live and replayed `action` notifications wrap the core action as
`{type: 'x-ai-browser/sessionChanged', change: <SessionAction>}`. Supported methods:

| Method | Behavior |
| --- | --- |
| `initialize` | Version check, explicit profile metadata, initial snapshots |
| `subscribe` / `unsubscribe` | Subscribe to an authorized conversation |
| `reconnect` | Replay retained actions or return fresh snapshots |
| `ping` | Connection check |
| `x-ai-browser/listSessions` | Authorized lightweight conversation catalog |
| `x-ai-browser/stop` | Forward Stop through the optional host control adapter |
| `x-ai-browser/approve` | Resolve an existing tool approval once |

Standard `dispatchAction`, chat creation, model changes, tools, terminal access,
question forms and secret answers are deliberately unsupported. In the extension,
the host has no control adapter and no AHP connection: this production bridge is
observation-only. The demo supplies an in-memory simulated control adapter.

Every embedding must authenticate its transport before creating a connection and
provide `canRead`, `canControl` and a stable authenticated `clientKey`. The wire's
`clientId` is display/reconnection metadata, not authorization. Read authorization
is checked on snapshots, discovery, recovery and every pushed event; control is
checked per request. No client may publish server state. An eventual Exchange
adapter must preserve its encryption, scoped grants and command allowlist.

Embeddings supply one synchronous `send(message)` callback for **both** RPC
responses and live notifications. It must synchronously consume the message or
enqueue it on a single ordered transport; it must not await network delivery.
An in-process client installs snapshot/replay state in that callback, before
processing subsequent actions. The promise returned by `receive()` tracks request
completion only, and is not a second response-delivery path.

Initialization, subscription and recovery produce their response without an
asynchronous yield. An outgoing FIFO also defers notifications triggered
reentrantly by the response callback until that callback finishes. This preserves
the snapshot/replay-before-live barrier. Queued live messages recheck current
read access before delivery; disposal drops the queue. Async backend controls
still wait for execution before emitting their reply.

Controls use increasing positive integer `commandId`s per authenticated peer.
The host retains the latest 32 results per peer and a high-water mark: an older
retry whose result expired is rejected, never re-executed. The prototype bounds
control peers at 128 per host lifetime. Both success and failure consume the
command ID. Failed approvals remain claimed while pending: after an uncertain
backend failure, reconcile actual runtime state instead of retrying the effect.
The host does not persist command results or guarantee exactly-once backend
execution across process failures.

## Run and verify

```sh
node --test src/chat/core/sessionHost.test.ts src/chat/core/ahpPrototype.test.ts src/chat/core/sessionHostIntegration.test.ts
npm run build-ext
node scripts/demo-session-host.mjs
```

The demo uses two simulated clients and no model, network, editor or credentials.
It checks streaming convergence, approval retry/competition, offline snapshot
recovery after replay eviction and Stop from the second client.

## Next milestones

1. Replace private projections with standard AHP chat/session state and actions,
   pinned official types/reducers and upstream conformance fixtures. Keep opaque
   stable IDs for chats and turns; a logical session can contain multiple chats.
2. Move runtime contracts and dependencies out of VS Code. Separate host lifetime,
   execution environment (machine/directories/worktree) and UI ownership. Add
   explicit detach/stop semantics and persist recoverable state.
3. Add an opt-in standalone process with authenticated local transport, bounded
   queues and process supervision. Prove it keeps a real agent running across UI
   reconnects. Declare editor-only capabilities unavailable after editor exit.
4. Route Chrome/Exchange through the proven host adapter without broadening their
   permissions or changing the encryption boundary.
5. Add one versioned managed canvas with a small validated action bridge; retain
   the existing arbitrary-HTML sandbox. Automations and isolated model comparison
   can then build on host execution environments.
