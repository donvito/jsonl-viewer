# JSONL Viewer v1.3.4

## What's new

- The **Traces** menu now has a tab per agent, so it can show the 20 most recent sessions for a source instead of three of each. Each tab carries that source's total and wears its harness colour, matching the explorer and the trace header. Your tab is remembered, and until you pick one the menu opens on whichever agent has the most recent session — so opening it mid-run lands where you are working.
- Opening a Codex trace that spawned subagents now offers to open them with it: *This trace spawned 4 subagents. Open them too?* The offer is inline in the trace header rather than a dialog, so it can be ignored while you read, and it only appears when there is something to open. **Always** and **Never** are remembered; **Not now** applies to that trace.
- Added **Open all** on the header's Subagents row, and **Open with N subagents** when right-clicking a trace in the explorer — shown only when that trace has any. Both open the whole subtree, since a subagent can spawn its own, and both leave the parent as the active file so the timeline you were reading stays put.
- Added a right-click menu on file tabs: **Close**, **Close Others**, **Close to the Right** and **Close All**. Entries that would do nothing are greyed rather than dropped, so the menu keeps its shape whichever tab you click. Closing several tabs asks once about unsaved work, listing the files it would discard.

## Fixes

- Fixed the **Open files** heading being cut in half in a short window. The label was allowed to shrink inside the sidebar's column layout, so a tall list squeezed it to half its line height — visible below about 460px of window height, and more likely since trace rows became two lines tall. The open files list is also capped now, so it scrolls instead of crowding out the folder tree.
