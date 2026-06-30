# Codex Chat / Assistant Logic Behavior Parity Checklist (deprecated)

This historical checklist is retained only to explain why Brain previously
contained assistant-runtime experiments. It is no longer production guidance and
must not be used to define Tim-facing assistant behavior.

Current boundary:

- Brain is a deployment/control-plane coordinator.
- The deployed assistant runtime is `codex-chat.service`.
- Assistant-domain behavior, skills, prompts, workflows, and account-specific
  integrations belong in the separate `assistant-agent-logic` checkout.
- Private assistant state belongs in `assistant-agent-data` / the private
  workspace, not in the Brain source tree.
- Brain deployment/update flows must refresh configured refs for `codex-chat`
  and `assistant-agent-logic`, verify resolved SHAs, and record those SHAs in
  deployment metadata.

Brain may keep lab compatibility tests and legacy snapshots for migration
confidence, but those paths are not live assistant behavior and must not be
installed as `brain-personal.service` or `brainctl run --telegram-polling`.
