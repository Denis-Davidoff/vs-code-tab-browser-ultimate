# Remote chat parity

Checked against the shared chat renderer, command validation, host dispatch and automated tests. This is a code and automated-test audit, not a live browser/VS Code end-to-end verification.

| Feature | Website / Chrome behavior |
| --- | --- |
| Send, Stop, queue, model and effort | Shared chat commands and conversation routing are covered by tests. |
| Change agent in an existing conversation | Same three choices and Cancel as the editor. Pending choice belongs to its conversation, including background conversations. Website and Chrome routing are tested for every choice. |
| Open a new VS Code browser tab | Website command opens the integrated browser directly; it works without an existing selected remote tab. |
| Open Chrome from website | Disabled in the menu and refused by the host. Local editor behavior is retained. |
| Close the selected remote page | The website × calls the selected page's close operation and releases its preview. It does not close a different active page. |
| Browser navigation, clicks, text and scrolling | Existing selected-page commands remain available. Touch, trackpad batching, zoom and routing have automated coverage. |
| Choose folder on website | Website dialog accepts a path on the VS Code computer; host checks that it is an existing absolute directory. `~/` is supported. Local editor uses the native folder dialog. |
| Recent/workspace folders, file listing and project-path attachments | Existing scoped folder commands are forwarded. |
| Remote screenshots, elements and annotations | Existing selected-page attachment routing has automated coverage. |
| Upload/paste files, clipboard and export on website | Website handles the local browser file picker, clipboard and download. |
| Skills, command listing, usage, awake/sleep and Git controls | Existing validated command paths are present; this does not establish that all CLI, authentication and Git scenarios work end to end. |

## Remaining gaps

- Git branch changes involving dirty files, offline fetch, branch-name conflicts or stash selection can still request native VS Code dialogs. These need remote versions of their prompts for full parity.
- History can be displayed, but opening/deleting arbitrary saved conversations is refused by the remote host policy. Terminal resume, CLI binary settings, temporary-storage management and arbitrary local file opening are also editor-only.
- Some content/file/diff actions open an editor in VS Code rather than a viewer on the website. Draft attachment previews and chat export have website handlers.
- Microphone recording remains unavailable on the website.
- Native authentication/trust prompts and OS dialogs are not mirrored.

The remaining gaps are not marked as working simply because a menu item exists. Remote DevTools and its transport have been removed.
