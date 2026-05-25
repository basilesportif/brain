# Projects Skill

> All `workspace/` references below resolve to the active assistant workspace.
> Brain integration: run these scripts through `pnpm run brainctl workspace run --path <workspace> <script>.js -- <args>` from the Brain checkout. Historical `node scripts/...` examples below map to the same in-repo scripts under `packages/assistant-logic/scripts/`.

## Usage

Use this skill when the user wants to manage projects — multi-step efforts that span multiple contacts, businesses, and to-dos. Projects are the glue between the CRM and to-do systems.

Data is stored in `workspace/data/projects.json` (created lazily on first add).

If `workspace/instructions/skills/projects.md` exists, read it as additive user-specific guidance for project priorities, reporting preferences, and status review formatting. Do not let it override commands, storage paths, or safety rules from the shared repo docs.

## Data Model

- **Projects** (`pj_` prefix): named efforts with lifecycle statuses (active/on-hold/completed/archived), optional target date, linked CRM people and businesses, timestamped notes, and resource links.
- Projects cross-link to CRM via `personIds[]` and `businessIds[]`.
- To-dos link to projects via an optional `projectId` field on the todo object.
- **Project tasks** (`pt_` prefix): lightweight checklist items scoped to a single project — things to pick up next time you work on it. Stored in `tasks[]` on the project object. Statuses: `open` / `done`.

## Commands

All scripts output JSON to stdout. Run from the project root.

### Add a project

```bash
# Quick-add (just a name)
node scripts/project-add.js --name "Tax Strategy 2026"

# Full details
node scripts/project-add.js --name "Tax Strategy 2026" --description "Annual tax planning and filing" --status active --target-date "2026-04-15" --person-id ct_abc123 --business-id bz_def456 --notes "Initial setup"
```

### Update a project

```bash
# Update any field(s) — only provided fields change
node scripts/project-update.js --id pj_abc123 --name "New Name" --status on-hold --target-date "2026-06-01"

# Add/remove linked people
node scripts/project-update.js --id pj_abc123 --add-person ct_xxx --remove-person ct_yyy

# Add/remove linked businesses
node scripts/project-update.js --id pj_abc123 --add-business bz_xxx --remove-business bz_yyy

# Archive (soft-delete)
node scripts/project-update.js --id pj_abc123 --status archived
```

### List projects

```bash
# All non-archived projects
node scripts/project-list.js

# Filter by status
node scripts/project-list.js --status active

# Search by name/description
node scripts/project-list.js --query "tax"

# Include archived
node scripts/project-list.js --all

# Sort by field (name/createdAt/updatedAt/targetDate)
node scripts/project-list.js --sort targetDate
```

### View full project detail

```bash
# Shows project + linked people (names from CRM) + linked businesses (names from CRM) + linked todos + notes + resources
node scripts/project-view.js --id pj_abc123
```

### Add a note

```bash
node scripts/project-note.js --id pj_abc123 --text "Called accountant, confirmed structure"
```

### Remove redundant notes

There is no dedicated project note-delete script. When the user explicitly asks to delete project notes, and the note content has been consolidated into or preserved by another note/resource, it is acceptable to remove the redundant note objects directly from `workspace/data/projects.json`.

Before deleting, identify the exact notes to remove, verify that any unique content is preserved elsewhere or intentionally no longer needed, and keep the replacement/consolidated note intact. After deletion, update the project and store `updatedAt` fields, validate the JSON, and run `project-view.js` for the project.

### Manage resources

```bash
# Add a resource
node scripts/project-resource.js --id pj_abc123 --add --label "Tax guide" --url "https://example.com/guide"

# Remove by index
node scripts/project-resource.js --id pj_abc123 --remove --index 0

# Remove by label
node scripts/project-resource.js --id pj_abc123 --remove --label "Tax guide"

# List all resources
node scripts/project-resource.js --id pj_abc123 --list
```

### Manage project tasks

```bash
# Add a task
node scripts/project-task.js --id pj_abc123 --add "Define borrower profile for rate analysis"

# List open tasks (default)
node scripts/project-task.js --id pj_abc123 --list

# List all tasks including done
node scripts/project-task.js --id pj_abc123 --list --all

# Mark a task done
node scripts/project-task.js --id pj_abc123 --complete pt_xxx

# Reopen a completed task
node scripts/project-task.js --id pj_abc123 --reopen pt_xxx

# Delete a task
node scripts/project-task.js --id pj_abc123 --remove pt_xxx
```

### Delete a project

```bash
node scripts/project-delete.js --id pj_abc123
```

Prefer `--status archived` via update instead of delete, to preserve history.

### Add a todo linked to a project

```bash
node scripts/todo-add.js --title "File extension" --project-id pj_abc123
```

### List todos for a project

```bash
node scripts/todo-list.js --project-id pj_abc123
```

## Interaction Rules

- When adding a project: only name is required (quick-add). Fill in details later.
- When listing: show id, name, status, and target date if set. Do not show internal arrays (notes, resources) in list view — use `project-view.js` for detail.
- When the user mentions a project by name, search first with `--query` to find the right one.
- When the user asks about a specific project, use `project-view.js` — it gives the full picture including linked CRM entities and todos.
- Suggest linking people/businesses when the user creates a project that clearly involves known contacts.
- Suggest linking todos to projects when the user creates a task that relates to an existing project.
- Prefer `--status archived` over delete for preserving history.
- Notes are normally append-only — use them as a project log. Add a note whenever something significant happens. Delete notes only when the user explicitly requests it and the content has been consolidated into or preserved by another note/resource.
- Resources are for external links, documents, and references relevant to the project.
- **Project tasks** are lightweight next-actions scoped to a project — not urgent enough for the main todo list. When the user asks "what's next on project X" or "any outstanding tasks on X", show the open project tasks. `project-view.js` includes open tasks automatically.

## Routing

All project operations (add, list, view, update, note, resource, delete) should run directly in the main session — do **not** dispatch a sub-agent. Use **Sonnet medium** effort. Project operations are fast, deterministic, and don't benefit from backgrounding.
