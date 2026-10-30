# Inline HTML visualizations in chat

Research date: 2026-10-30. Research and proposed design only; no renderer or runtime changes.

Implementation follow-up: the initial file/snapshot renderer is now described in
[chat-visualizations.md](chat-visualizations.md). The findings and alternatives below are the
research baseline, not a statement that full MCP Apps or vendor-private runtimes were added.

## Findings and confidence

There are three different integration contracts, with similar visible results:

| Contract | How the host discovers the view | What is established |
| --- | --- | --- |
| Bundled OpenAI Visualize | A special assistant-text marker containing JSON with an absolute `path` | Confirmed in the locally installed skill and export renderer |
| Claude custom visuals / artifacts | Product-specific facilities; artifacts can also be published from Claude Code | Product behavior documented; exact native inline wire format not captured in this investigation |
| MCP Apps | Tool descriptor `_meta.ui.resourceUri`, followed by `resources/read` | Public standard with an official host bridge and sandbox example |

Generating HTML is an agent capability. Reading it, deciding whether it belongs to this conversation, isolating it, and rendering it are host responsibilities. A marker is a request to display content, not authorization to read arbitrary files or execute host operations.

OpenAI's current [Visualizations documentation](https://learn.chatgpt.com/docs/visualizations) says rendering is available on supported ChatGPT surfaces and is not supported by the Codex CLI or IDE extension. Generating the reference and displaying it are separate capabilities. Do not infer support from an agent's name or model.

## Exact locally observed OpenAI marker

Source: `/Users/m5/.codex/plugins/cache/openai-bundled/visualize/1.0.55/skills/visualize/SKILL.md`, section “Inline HTML output contract”. The reference is:

```text
visualize{"path":"/absolute/executor/path/example.html"}
```

The delimiters are U+E200, U+E202, and U+E201. An escaped representation for parser fixtures is:

```json
"\uE200visualize\uE202{\"path\":\"/absolute/executor/path/example.html\"}\uE201"
```

The JSON can also contain `mode: "wide"` and `title`. The path points to an executor-side file, not a web URL. The observed authoring contract requires an HTML fragment, limits it to 1 MB, and places the reference in the final response, including when updating an existing visualization. It does not establish a file-watching or partial-file execution protocol.

The local export helper is `scripts/render.py` beside that skill. It wraps the fragment, injects styles and a compatibility bridge, and creates a `sandbox="allow-scripts"` iframe without `allow-same-origin`. Its CSP permits selected CDNs and includes `unsafe-eval`, while `connect-src` is restricted to `blob:` and `data:`. This is evidence about the standalone export helper, not proof of the production desktop renderer implementation. The helper also explicitly notes that `srcdoc` inherits the shell CSP.

Do not copy that broad execution policy by default. A smaller host-controlled runtime with packaged chart/math libraries is a better initial scope for this project.

## Claude: keep native visuals and published artifacts separate

Anthropic documents [custom visuals](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat-and-cowork) as inline HTML-based interactive output that can be revised during a conversation. It distinguishes these ephemeral visuals from persistent artifacts. That page does not specify a reusable JSON envelope or streaming protocol for third-party hosts.

[Claude Code artifacts](https://code.claude.com/docs/en/artifacts) are another route: Claude writes a local HTML or Markdown file, publishes it to a private claude.ai URL, and republishes revisions to the same URL. Publication creates versions. This is not equivalent to a local inline-file reference, and embedding its viewer may involve login and framing restrictions. We should not silently turn a request for a local preview into a cloud publication.

No native Claude inline marker was verified here. In particular, do not assume older `antArtifact` examples on the internet describe the current Claude Code stream. Capture the actual client/version and raw events before adding an adapter.

## Public interoperability route

The [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview) describes interactive resources delivered through MCP. A tool points to a UI resource:

```json
{
  "name": "render_chart",
  "inputSchema": { "type": "object" },
  "_meta": { "ui": { "resourceUri": "ui://charts/view.html" } }
}
```

The host reads it using `resources/read`; the UI resource MIME type is `text/html;profile=mcp-app`. This `ui://` URI is resolved against the originating MCP server, not the local filesystem or arbitrary network.

The [stable specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) defines JSON-RPC over `postMessage`, initialization, tool input/results, and optional partial-input notifications for previews. For web hosts it requires a sandbox proxy on a different origin. Partial tool arguments are not permission to run incomplete generated HTML.

[OpenAI's UI integration documentation](https://developers.openai.com/plugins/build/chatgpt-ui) recommends this shared contract. Its compatibility mapping identifies `_meta["openai/outputTemplate"]` as the OpenAI alias for `_meta.ui.resourceUri`. This metadata belongs to the tool descriptor; it is distinct from a Visualize marker inside assistant text. `window.openai` is an additional host API, not a browser feature.

The [official sandbox example](https://github.com/modelcontextprotocol/ext-apps/blob/main/examples/basic-host/src/sandbox.ts) uses a separate-origin outer proxy and an inner view. It validates message source/origin and applies CSP through response headers. Its local-development origin checks must be adapted before deployment; copying localhost assumptions is insufficient.

## Existing project integration points

These findings describe the current checkout, including pre-existing uncommitted changes:

| Location | Current behavior | Consequence |
| --- | --- | --- |
| `src/chat/agentProtocol.ts`, `codexEvents` | `item/agentMessage/delta` becomes a text event | A text marker can arrive split across arbitrary delta boundaries |
| Same file, `claudeEvents` | Claude `content_block_delta` / `text_delta` becomes text | A shared content layer can support both without provider-specific DOM code |
| `src/chat/chatProtocol.ts`, `ChatEntry` | Assistant entries contain text; there is no artifact model | Add structured content/registry metadata without losing the original transcript |
| `preview-src/chat.ts`, `renderMarkdown` | Creates text nodes and code blocks; does not execute raw HTML | Preserve this behavior for normal messages, quoted examples, and tool output |
| Same file, `signature` and render loop | Changed entries can replace their DOM row | Artifact frames need stable identity independent of changing message text |
| `src/chat/chatView.ts`, `_html` | Strict nonce script CSP, no frame source allowed | A `srcdoc` addition alone will not provide a compatible execution environment |
| `preview-src/chat.ts`, global `message` listener | Dispatches `event.data` as `HostToView` without checking source/origin | An added untrusted child frame must never enter this trusted dispatch path |
| `preview-src/serverChatHost.ts`, `chrome-extension/sidepanel.ts` | Trusted adapters synthesize `MessageEvent`s on `window` | Refactor trusted delivery to an explicit host subscription rather than breaking it with an indiscriminate origin filter |
| `src/chat/chatSurface.ts` | Publishes state to Chrome and Exchange consumers | Remote clients need authorized bytes or artifact IDs; a desktop path cannot be fetched there |
| `chrome-extension/manifest.json` | MV3 extension-page CSP; no declared sandbox pages | Chrome needs an explicit sandbox-page design or isolated external renderer |

The unchecked message listener is a prerequisite to fix before allowing generated frames. It is not evidence that arbitrary HTML can currently execute in the chat: the current renderer and CSP prevent the proposed entry point.

## Proposed project architecture

This section is a design recommendation, not a claim about either vendor's internal implementation.

```text
Provider stream / explicit presentation tool
    -> content adapter and artifact registration
    -> host-owned artifact registry and revision store
    -> authorized bytes for this conversation
    -> persistent artifact card
    -> isolated renderer with a narrow bridge
```

Use one internal artifact model for all providers. A proposed record contains `id`, owning conversation and turn, provider, MIME type, format (`fragment` or `document`), title, revision, content hash, byte length, and loading/error status. Keep executor paths private to the host registry. Transport opaque IDs and revisions to remote surfaces.

Prefer an explicit provider-neutral presentation tool, for example `present_html({path, id?, title?})`. That name is proposed, not an existing tool. The tool validates and snapshots a completed file. A host instruction teaches each agent when to use it. The OpenAI marker can be a compatibility adapter into that same registration path. MCP Apps can be a later adapter once resource metadata and resource reads are preserved end to end; today's text/tool summaries alone do not constitute MCP Apps support.

### Reading files

Provision a per-conversation output directory and tell the agent to write there. Bind registrations to the active conversation; possession of a path string is insufficient.

Resolve the allowed root and candidate canonically; reject escapes, non-local schemes, UNC/network destinations, symlinks escaping the root, directories, device files, sockets, and oversized/non-UTF-8 data. Avoid a check-then-open race: open with appropriate no-follow support, inspect the descriptor, bound the read, and verify that the opened file belongs to the permitted location. Exact race resistance is platform-specific and needs implementation tests. A dedicated directory with controlled ownership reduces this surface.

Never introduce a generic `GET /file?path=...` endpoint. A remote fetch is by registered artifact ID, scoped to conversation access and revision; it must not expose filesystem paths, extension tokens, or unrelated workspace bytes. Store immutable snapshots so old chat messages remain reproducible after the source file changes or disappears.

### Rendering and host permissions

Do not inject generated markup into the chat DOM. Keep normal Markdown inert. Start with a renderer origin containing no account cookies, credentials, storage secrets, or privileged APIs. For a custom local viewer, prefer an opaque-origin frame with only `allow-scripts`; do not add popups, forms, downloads, top navigation, or same-origin access just to make a demo work.

The [iframe documentation](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) warns against combining `allow-scripts` and `allow-same-origin` when embedded content shares the host origin. MCP Apps' separate-origin proxy architecture is a different arrangement; do not transplant its flags into a same-origin chat iframe.

Use a host-owned wrapper with policy established before untrusted content and, where served, enforce CSP using headers. A starting renderer policy is:

```text
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data:;
font-src data:;
connect-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
worker-src 'none';
```

This is a starting restriction, not a complete containment guarantee or a CSP to put on the main chat. Add packaged libraries through an explicitly designed resource mechanism. Avoid `unsafe-eval` and arbitrary CDN access initially. [CSP policies intersect](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy): an inner policy cannot loosen the inherited restrictions of a `srcdoc` parent. Verify the actual VS Code nested-frame/resource behavior before selecting its renderer transport.

For Chrome, investigate declared [extension sandbox pages](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox), which have a separate CSP and cannot access extension APIs. The generated code must not run in the privileged side-panel page. For Exchange, use a distinct renderer origin with no credentials or permissive CORS to the chat API. These transports can differ while the artifact protocol stays shared.

The bridge initially accepts only readiness, bounded resize, bounded local widget state, and runtime-error reports. Bind it to the exact frame instance and revision, preferably with a dedicated `MessageChannel` established by a validated handshake. Check source and expected origin where an origin exists; `origin === "null"` alone cannot identify an opaque-origin frame. Validate schemas, sizes, frequencies, and lifecycle. Keep it entirely separate from `HostToView` and `ViewToHost`.

Do not pass through arbitrary `postMessage`, MCP tool calls, `acquireVsCodeApi`, or the chat's state. A follow-up action, if added, should create a visible draft or require the existing host-mediated user action. Viewer access must not become controller access through widget buttons.

Neither iframe sandboxing nor `connect-src 'none'` alone proves zero network egress: other resource types, allowed CDNs, and document navigation matter. Do not send secrets to the renderer. A hard no-egress requirement needs browser-level request/navigation enforcement or a more constrained rendering environment. Similarly, an iframe does not impose hard CPU/memory limits; infinite loops need explicit testing and an isolation/termination strategy.

### Updating during generation

Separate three cases:

1. **Interaction:** slider/button changes local chart state without agent involvement.
2. **Data update:** deliver versioned validated data to a persistent trusted chart view; avoid re-running scripts or losing selection.
3. **Code update:** register a new completed HTML snapshot, create a fresh isolated frame, and replace the old view after readiness. Preserve only bounded JSON state, never a live execution context.

For the first version, publish after a completed write or presentation-tool call. An optional watched-file preview should debounce writes, handle atomic rename, revalidate each read, deduplicate by hash, and retain the last good revision on error. A quiet interval is not proof of a complete file; explicit commits are preferable. Do not execute every file append or text delta.

Use explicit `id` plus monotonically increasing revision for updates to the same artifact. Do not identify it solely by path: an agent can reuse a filename for a different result. Ignore out-of-order delivery, unsubscribe on close, and stop hidden/unneeded renderers. Older transcript entries should pin a snapshot; a latest-version view should be explicit.

Incremental marker parsing must buffer split delimiters/JSON, bound length and count, recognize only valid complete markers outside code/quoted examples in assistant output, and leave malformed/unknown content inert. Never scrape arbitrary JSON with a `path` key or auto-render every `.html` link.

## Implementation order and acceptance checks

1. Capture real output for Codex and Claude: client and CLI versions, raw text/event envelopes, referenced bytes, and a second revision. Establish whether the provider sends an explicit update or only rewrites a file.
2. Build the registry and explicit presentation contract, including conversation ownership and immutable revisions.
3. Replace ambient trusted message delivery with an authenticated/explicit transport; add a separate artifact bridge.
4. Prove isolation for a minimal renderer in VS Code, Chrome, and Exchange. Do not weaken the main chat CSP to make a `srcdoc` prototype execute.
5. Add persistent cards, completed-file revisions, error display, and remote retrieval under existing conversation access.
6. Add marker compatibility and agent instructions, then MCP Apps if wanted. Treat formulas and static diagrams as optional dedicated renderers with smaller capabilities.

Necessary tests include split/truncated/quoted markers; path traversal, symlink replacement and oversized files; an artifact attempting to forge `state`, `recording`, or terminal messages; DOM/storage/credential access; fetch, image/CSS egress, self/top navigation and popups; cross-conversation and viewer/controller isolation; rapid writes, atomic replacement and stale revisions; state survival while surrounding assistant text streams; history restore and source deletion; and an infinite-loop artifact. Run browser behavior checks in each actual host, since a standalone browser page cannot establish VS Code or Chrome-extension CSP compatibility.

## Open questions for live captures

- Does the user's observed Codex response contain exactly the Visualize marker above, or another attachment/reference envelope?
- Is the requested native experience inline custom visuals, a persistent artifact panel, or both?
- Does the second turn reuse a file, emit a fresh reference, or send a distinct update event?
- Which Claude capability exists in the locally installed CLI and its `stream-json` output? Public product docs do not guarantee a given local version or feature flag.
- Can a strict packaged-library renderer cover the desired diagrams, formulas, and charts without executing arbitrary third-party imports?

Until those captures exist, the exact native update behavior and production viewer internals remain unverified. The project architecture above can be implemented without depending on those private details.
