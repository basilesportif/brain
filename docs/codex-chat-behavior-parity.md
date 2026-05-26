# Codex Chat / Assistant Logic Behavior Parity Checklist

Brain keeps Tim-facing behavior aligned with the current `codex-chat` + `assistant-agent-logic` workflow while preserving Brain's provider-neutral architecture.

## Implemented parity surfaces

- **Telegram ingress**: user messages get an immediate service-level 👀 reaction before provider work; voice/audio/video transcription is handled at the Telegram adapter edge when configured, with codex-chat-style failure messages instead of silent generic provider input.
- **Behavior prompt pack**: every runtime turn now includes routing rules, skill-read requirements, directive syntax, todo post-mutation rules, file-save privacy rules, generated-image routing, scratch-page/codex-chat-web routing, loop/monitor guidance, setup/migration boundaries, and active subagent steering instructions.
- **Main loop vs subagent routing**: prompts require deterministic todo/project/file-save operations to stay in the main loop and require subagents for repo inspection, code/docs changes, debugging, research, calendar/email/Gmail/finance/health/betting live account reads, generated images, and scratch web pages.
- **Todos**: `todo-add.js`, `todo-list.js`, and `todo-delete.js` are native Brain commands. After every add/delete, the actor must run `todo-list.js` and include the full updated numbered list in the same reply.
- **Projects/resources/tasks**: native `project-*.js` commands cover add/list/view/update/delete, notes, resources, and project-scoped tasks.
- **CRM and reminders**: native `crm-*.js` and `reminder-*.js` commands cover JSON-backed local operations. Live calendar/email/Gmail/Composio work is vendored but credential-dependent and should be delegated to a subagent.
- **File-save/PDF attach**: `file-save.js` copies attachment bytes into private workspace storage and appends metadata without committing private files to source repos.
- **Generated images**: prompts require an `implementer` subagent to own imagegen, stage selected output under temporary artifacts, and return a send directive with cleanup for staged generated copies.
- **Scratch pages / codex-chat-web**: prompts require the generated-web-page skill, repo-registry authority resolution, artifact-directory builds, static validation, publisher-only deployment to unlisted `/pages/<id>/` URLs, manifest verification, and TTL/pruning or promotion reporting.
- **Subagent dispatch visibility**: `dispatch_subagent` runtime actions are consumed internally and immediately produce a user-visible dispatch message containing summary, profile, model, effort, route, job id, and short ref.
- **Subagent results**: `return_to_main` results are sent back through the main runtime; if the main runtime is silent, Brain sends a direct fallback completion/failure summary to the original entrypoint.
- **Subagent status and steering**: `agents`, `agents detail`, `agent status <ref>`, `agent kill <ref>`, and `agent steer <ref> <text>` are intercepted before provider turns; active job snapshots are injected into prompts for natural-language steering.
- **Loops/monitors**: automation seams preserve route choices and subagent dispatch for investigation/remediation without requiring Telegram ACKs.
- **Setup/workspace migration**: setup scaffolds JSON state, overlays, private document metadata, tasks, and repo-registry paths; live credentials remain private and validation is metadata-only unless explicitly allowed.

## Credential-dependent parity

The code paths and vendored commands exist for calendar, Gmail/email, Composio connection management, ProtonMail, finance/Mercury/Plaid, Whoop, Telegram user-client messaging, betting, generated web publishing, and Google Maps page keys. Live validation of those paths requires Tim's private credentials/account state and should be performed with metadata-safe checks first.

## Regression checks

Run:

```sh
pnpm run check
```

The check suite covers native assistant-logic command compatibility, Telegram reaction/transcription boundaries, generated-page validation/publish/prune primitives, subagent dispatch/status/steering/control seams, active snapshot prompt injection, visible dispatch feedback, and return-to-main fallback summaries.
