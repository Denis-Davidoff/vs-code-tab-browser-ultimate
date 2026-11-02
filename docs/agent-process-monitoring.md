# Processes owned by a conversation

The Bash tab needs to distinguish a finished launcher from a server it left running. Ownership must follow the originating chat, including when several Codex threads use the same app-server. A shared CLI PID, working directory, executable name, or matching launch time is not evidence of chat ownership.

## Implemented experiment

`src/chat/agentProcesses.ts` maintains one runtime registry per extension host. Commands receive `AI_BROWSER_PROCESS_OWNER`, a stable, non-secret hash of the chat ID and provider. This is correlation metadata, not an authentication or security boundary.

Codex receives a dotted `shell_environment_policy.set` override on thread start/resume/fork; existing user environment settings are preserved. This path was checked against installed codex-cli 0.164.0 using an ephemeral thread and `thread/shellCommand`, without a model call. Claude, Gemini, OpenCode and Pi receive the marker when their conversation CLI starts. Detection, title and commit-message probes have no conversation marker. Descendant MCP helpers of a conversation CLI can also appear; they are processes started for the conversation.

The sampler combines two kinds of evidence:

- A matching environment marker attributes a process even when its launcher has already exited or it has changed session/process group.
- A previously observed ancestor attributes descendants that clear their environment. Once recorded, attribution survives reparenting. An unlabelled shared Codex ancestor never attributes a process to a chat.

Rows retain PID plus OS-reported creation time, executable name, provider, attribution evidence and first-observed time. The UI shows processes observed for at least five seconds in **Bash → Observed processes · this chat**. It does not imply that this is a complete list of every process ever created. Stops recheck chat membership and creation time against a fresh process table, then send SIGTERM only to that PID. CLI protocol session IDs are never treated as OS PIDs.

Markers are deterministic so a restored chat can rediscover a surviving marked server. A server started before marker injection cannot be attributed retroactively from its name or directory. Logs redirected by the command remain at their original destination; discovering a PID does not recover a stdout stream.

## Cost and isolation

- One asynchronous process-table read per window every five seconds while CLIs exist, fifteen seconds while checking survivors or finishing discovery. Checks stop once there are no CLI roots, known survivors or pending discovery. Command lifecycle events can advance a check, with a one-second minimum gap; output chunks do not trigger scans. Failures back off to thirty seconds.
- Environment discovery is capped at 64 candidate PIDs per scan; unmarked identities are retried once. Disappeared identities leave the cache. New processes are prioritized by birth time, not PID, because PIDs wrap.
- At most 128 CLI roots, 1,024 owner markers and 2,048 tracked processes; at most 256 rows per chat are sent to the view. Reaching a tracking/display limit is reported.
- `ps` has a 1.5-second timeout and an 8 MiB output bound. Linux reads `/proc/PID/environ` in batches of eight. macOS reads environment data only for selected candidates. Only the marker is retained; raw environments and argument strings are never logged or sent to the UI.
- A small editor-only event updates Bash when that chat's snapshot changes. It does not rebuild message DOM, append chat entries, save conversation history, consume model tokens, or publish process metadata through Exchange/Chrome. Hidden views receive the current snapshot on their next ordinary state update.

The real macOS integration probe recovered two immediately detached Node servers, assigned them to separate chats, recovered them with a fresh registry, and verified scoped stopping. In one run, two initial scans took 61 ms wall time in total. This is a functional probe and a sample latency measurement, not a CPU benchmark or a measured percentage of coverage.

## Why this is not a 99–100% guarantee

Environment markers plus sampling improve coverage of ordinary dev servers, but cannot establish such a guarantee. A process can clear the marker and detach entirely between scans. Some macOS system executables hide environment data. Codex environment allowlists can remove the marker. A program can spoof correlation metadata. PID creation times from `ps` have one-second precision, rather than the stronger identity available from native APIs. Heavy process churn can exceed discovery limits. A short-lived process can begin and exit between samples.

Delegation also changes the meaning of ownership. `docker run`, a request to an already running process manager, an SSH command, or a launchd/systemd service can create work in another process tree or machine. A local descendant monitor cannot infer ownership of those resources. The UI must not silently guess.

## Architecture for stronger coverage

To approach comprehensive coverage, establish ownership at the actual command launch boundary and consume OS process lifecycle events. Keep the UI protocol and per-chat registry; replace the sampling discovery adapter where the platform supports stronger evidence.

1. A provider adapter supplies an immutable chat, agent/thread and command identity to a launch broker **before** the command begins. Shared providers need per-command integration; isolating the whole shared app-server does not separate chats. A protocol's tool session ID is only a correlation key.
2. The broker registers process identity before allowing user code to fork. Use native creation identity plus boot identity; use pidfd/handles where available when stopping. Preserve lineage after every fork/exec/exit rather than reconstructing it later. Event loss, observer restart and unsupported launches must mark coverage as incomplete.
3. Linux can put commands in delegated cgroup v2 scopes before execution. Children inherit membership across ordinary fork/exec and setsid. Scope migration permissions must prevent escape if membership is meant as a guarantee. A privileged event source is required if the requirement includes every short-lived descendant, not just current scope membership.
4. Windows can create commands suspended, assign them to a Job Object with breakaway disabled, and resume them. Integrate job notifications and stable process handles. Account for nested-job constraints and launches delegated to services; a process manager's work is not automatically a child in the caller's job.
5. On macOS, a signed native Endpoint Security client can observe fork/exec/exit, with the required Apple entitlement and applicable runtime permissions. This is a separate installation/distribution concern, not a guarantee supplied by an ordinary VS Code JavaScript extension. An environment marker or dedicated launch boundary is still required to separate commands from different chats below a shared CLI. Process groups alone are insufficient because setsid can escape them.
6. Add explicit adapters for delegated resources: container labels, service unit names, supervisor job IDs and remote host scopes. Display them as resources owned by a command, separately from local PIDs.

For an event observer, record loss counters, coverage gaps, and reconnection epochs. Keep event handling and bounded metadata storage outside conversation rendering. Publish batched deltas only for the visible chat; load richer process detail on demand. Monitoring never needs a model request.

## Acceptance criteria before advertising a percentage

Measure attribution precision and discovery recall separately. Define the denominator: processes spawned directly by instrumented local commands, which platforms/providers, whether short-lived processes count, and how delegated resources are handled. A passing list of examples is not a measured 99% rate.

Use an independent ground-truth launcher to record unique creation identities across thousands of generated launches. Include concurrent chats sharing cwd and executable, immediate parent exit, nohup, setsid, double-fork, environment clearing, inherited marker filtering, nested agents, fork storms, PID wrap/reuse, observer/extension restart, denied OS reads, overflow/event loss, and delegated/container launches. Assert no cross-chat attribution or stops. Measure idle and burst CPU, memory, UI frame responsiveness and publication counts. Report unsupported cases and confidence intervals with results.

## Verification

`node --test src/chat/agentProcesses.test.ts` checks ownership, reparenting, bounded reads, PID reuse, stale snapshots, coalescing, disposal and scoped stopping. `node scripts/test-agent-processes.mjs` exercises real detached processes and registry recovery on macOS/Linux, and always cleans up its own test processes. The browser surface smoke test checks process-only Bash updates without rebuilding conversation DOM, Stop scope, and rejection of a late delta for another chat.

## Primary references

- [Official OpenAI documentation: shell environment policy](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy)
- [Official OpenAI documentation: app-server](https://learn.chatgpt.com/docs/app-server)
- [Linux kernel: cgroup v2](https://cdn.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
- [Apple: Endpoint Security](https://developer.apple.com/documentation/endpointsecurity) and [client entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.endpoint-security.client)
- [Microsoft: Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
