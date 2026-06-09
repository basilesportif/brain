# Codex Chat parity prompt fragment (deprecated)

This file is intentionally non-behavioral. Brain must not define Tim-facing
assistant behavior, domain routing, todo/project semantics, generated-image
workflow, scratch-page workflow, live-account access, or subagent policy for
production traffic.

Production assistant behavior lives in the separate `assistant-agent-logic`
checkout and is executed by the real `codex-chat.service`. Brain may load this
file only for lab/runtime smoke context, where it should reinforce the boundary:

- do not deploy Brain's Telegram supervisor as the assistant;
- do not copy assistant-agent-logic prompts or skills into Brain as canonical
  behavior;
- do not migrate private assistant data into the Brain source tree;
- verify `codex-chat` and `assistant-agent-logic` refs and record resolved SHAs
  through deployment metadata.
