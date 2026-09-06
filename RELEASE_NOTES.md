# JSONL Viewer v1.3.2

## What's new

- Added live streaming of agent traces. Open a session file while Codex, Claude Code, Pi, or Hermes is still writing it and new entries appear as they land — only the appended bytes are read, and entries are patched into the timeline instead of redrawing it, so scroll position, expanded sections, and text selection all survive the update.
- Added a **LIVE** badge on the trace header while a session is being written to, and in the **Traces** menu for sessions touched in the last couple of minutes, so the run you are in is easy to spot.
- The trace view now keeps the newest entry in sight. Scroll back to read and following pauses, with a **N new entries** pill to jump back to the newest.
- Added an **Oldest first** / **Newest first** toggle to the Traces view; newest first puts the latest entry at the top and streams new ones in above what you are reading. The choice is remembered.

## Fixes

- Fixed the open file not reloading when another program appended to it. The watcher only watched the containing directory, which on macOS never reports an in-place append, so a growing session file looked frozen. The file itself is now watched directly, with a slow stat check as a backstop for filesystems that report neither.
- A half-written last line is now replaced by the finished line rather than duplicated once the writer completes it.
