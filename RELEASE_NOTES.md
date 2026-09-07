# JSONL Viewer v1.3.3

## What's new

- Codex traces are now labelled **MAIN** or **SUBAGENT**. The label comes from `session_meta.thread_source` and nothing else — not the model, the filename, or the agent role — so a trace is only labelled when the rollout actually says so. A subagent trace also shows its role, agent path and nickname in the header.
- Subagent traces are nested under the trace that spawned them, in both the folder tree and the **Open files** list. The link is the id pair Codex already records: a subagent belongs to the trace whose id matches its `parent_thread_id`.
- A main trace lists its subagents in the header, by role and nickname, and a subagent shows a link back to its parent. Clicking either opens that trace. Opening a Codex rollout now looks at its sibling files, so the links resolve without having to open the folder first. If the parent is not among the files seen, the subagent still appears and shows the parent id as unresolved.
- The file explorer says which agent wrote each file. Every trace row now carries a second line naming the harness — Codex, Claude Code, Pi or Hermes — with a colour per agent, alongside the MAIN/SUBAGENT label. This works for files that have only been listed, not just the ones you have opened; the harness is read from the head of the file. Rows that are not traces stay one line tall.
- Codex traces show the reasoning effort they ran at, next to the model — `GPT-6 Astra · Low`. Effort is a per-turn setting, so each assistant turn carries its own badge and a session that changes gears shows the progression. It is read from the agent's own `turn_context`, preferring `collaboration_mode.settings.reasoning_effort` over the top-level `effort`, which on a subagent can still hold inherited root state.
- Known Codex model ids read as names — `gpt-6-astra` as **GPT-6 Astra**. This is a fixed list rather than a rule that rewrites arbitrary strings, so an unrecognised id is shown exactly as it was recorded, with the raw id and its provider kept in the tooltip.
- The **Traces** menu is wider and no longer truncates session filenames, and Codex entries carry their MAIN/SUBAGENT label. The harness name is coloured to match the explorer, so the same agent looks the same everywhere it is named.

## Fixes

- Fixed Claude Code sessions being labelled **Hermes**. Hermes exports share Claude Code's record shape, and detection matched on that shape (`sessionId` together with `parentUuid`), which every Claude Code session also has — so Hermes claimed all of them. Detection now requires a marker only Hermes has: its version stamp, or the export directory.
