# Temporary files

Chat Settings → Temporary files shows extension-created folders, file counts, sizes,
protected files, and project/all cleanup. Refresh reads disk; the index stores paths,
project ownership and producer process IDs, never captured content.

| Files | Location | Lifetime / manual cleanup |
| --- | --- | --- |
| Screenshots and materialized image attachments | ~/.ai-browser/projects/<id>/captures or shared/captures | Existing automatic 24-hour sweep; manual cleanup supported |
| Browser videos | ~/.ai-browser/projects/<id>/captures or shared/captures | Kept until manual cleanup; Save as creates an independent copy |
| Voice capture | ~/.ai-browser/projects/<id>/captures or shared/captures | Recorder normally removes its file; abandoned files can be cleaned |
| Element reports and chat exports | <project>/.ai-browser or ~/.ai-browser/projects/<id>/reports / shared/reports | Existing five-hour report sweep; manual cleanup supports known report names |
| Claude MCP connection files | ~/.ai-browser/shared/runtime/chat | Existing stale-process sweep; manual cleanup only after owner process exits |
| Isolated title/branch/commit request instructions | ~/.ai-browser/shared/runtime / isolated request folders | Normally removed in finally; abandoned instructions older than 24 hours can be cleaned |
| Inventory metadata | ~/.ai-browser/inventory | Separate private record per artifact; stale records removed during cleanup |

New captures and reports record the project selected when created. Project reports
can also be attributed from their directory. Older shared temp captures without
ownership metadata appear in all-project accounting and are cleaned only by the
all-project action. Files in a live producer process belonging to another window
are protected. Current draft attachments, active recordings and agent requests,
files younger than one minute, and isolated AI request instructions younger than
24 hours are also protected. Manual cleanup can remove older legacy captures even
when they have no ownership record. Cleanup does not follow symbolic links or recursively remove folders.

Cleanup deliberately excludes saved chat history, downloaded agent binaries, login
storage, user exports made with Save as, MCP settings in projects/home directories,
repository clones/worktrees/references, and active sleep/configuration locks. These
are persistent data or live coordination state, not disposable captures. Old chat
messages and external clients may contain references to files explicitly cleaned;
those references can become unavailable, as explained in the settings panel.

New files use the private home root `~/.ai-browser` (0700). A project ID is a stable
hash of its full path; project folders with identical names stay separate. Unknown
ownership uses `shared`; registered miscellaneous disposable files can use
`shared/files`. Direct project-local helpers use `<project>/.ai-browser` and its
existing `.gitignore`. Existing OS-temp files are not moved, so links stay valid;
the cleanup panel also scans the previous private root and its ownership records.
If the home root is unsafe (a symlink or accessible to other users), the private
OS-temp fallback remains available. Custom directories are created only as needed.
