# workspace boundary

This directory marks where a self-hosted user workspace may be mounted or symlinked in future designs. Its contents are ignored by git.

Do not commit user instructions, credentials, personal state, chat transcripts, generated pages, or repo-registry state here.

The setup flow now creates the assistant-agent-logic-compatible JSON workspace
model in the configured workspace. The authoritative personal state is:

- `data/todos.json`
- `data/projects/` (markdown notes are source of truth; `index.json`/`project.json` are a rebuildable index — see `pnpm run brainctl workspace run --path <workspace> project-reindex.js`)
- `data/crm.json`
- `data/reminders.json`
- `private/documents/metadata.jsonl` for file-save metadata
- `instructions/skills/*.md` and `instructions/prompts/*.md` for user-specific overlays
- `tasks/` for scheduled task metadata/instructions
- `.claude/repo-registry/` for selected private repo-registry state

Brain should reuse assistant-agent-logic scripts against these files, for
example:

```bash
pnpm run brainctl workspace run --path <workspace> todo-list.js
pnpm run brainctl workspace run --path <workspace> project-list.js
pnpm run brainctl workspace run --path <workspace> crm-list-people.js
pnpm run brainctl workspace run --path <workspace> reminder-list.js
pnpm run brainctl workspace run --path <workspace> file-list.js
```

Legacy markdown paths are still created as supporting project resources only,
not as the source of truth:

- `projects/`
- `notes/`
- `documents/`
- `documents/metadata/`

Commit non-secret workspace memory only to the user's private workspace backup
repo, not this public source checkout.
