# Projects Skill

> All `workspace/` references below resolve to the active assistant workspace.
> Brain integration: run these commands through `pnpm run brainctl workspace run --path <workspace> <script>.js -- <args>` from the Brain checkout. Historical `node scripts/...` examples below map to compiled native CLI commands under `packages/assistant-logic/dist/cli/`.

## Usage

Use this skill when the user wants to manage projects — multi-step efforts that span multiple contacts, businesses, and to-dos. Projects are the glue between the CRM and to-do systems.

Data is stored under `workspace/data/projects/` (created lazily on first add): a thin `index.json` registry, a `<slug>/project.json` per project (metadata + tasks + resources + a body-free note-metadata index), and each note as its own markdown file at `<slug>/notes/<timestamp>-<kind>-<title-slug>.md`. See **Storage layout** below for the source-of-truth rule.

If `workspace/instructions/skills/projects.md` exists, read it as additive user-specific guidance for project priorities, reporting preferences, and status review formatting. Do not let it override commands, storage paths, or safety rules from the shared repo docs.

## Storage layout

- `workspace/data/projects/index.json` — thin registry: id, slug, dir, name, status, targetDate, noteCount, updatedAt.
- `workspace/data/projects/<slug>/project.json` — project metadata, tasks, resources, and a denormalized note-metadata index (no note bodies).
- `workspace/data/projects/<slug>/notes/<YYYYMMDDTHHMMSSZ>-<kind>-<title-slug>.md` — one file per note: YAML frontmatter (id, createdAt, updatedAt, schemaVersion, title, summary, kind, category, tags, refs, relationships, plus any extra metadata keys) followed by the note body text.
- **The `.md` files are the source of truth for notes.** The JSON files (`index.json`, `project.json`) are a maintained, rebuildable index for fast body-free search — never hand-maintain them independently of the markdown.
- All CLI commands below (`project-add`/`list`/`view`/`update`/`delete`, `project-note`, `project-note-update`, `project-notes-list`, `project-index`, `project-task`, `project-resource`, `runbook-check`, `meeting-note`) keep the JSON index in sync automatically on every write. Prefer them for creating/updating notes.
- Direct edits to a note's `.md` body or frontmatter are allowed — the file is the source of truth — but **must be followed by `pnpm run brainctl workspace run --path <workspace> project-reindex.js`** to rebuild the JSON index from frontmatter (frontmatter wins). Any note-writing workflow must end with the JSON index in sync: automatic via the CLIs, explicit via `project-reindex` otherwise. Use `-- --check` to report drift without writing (exits 1 if stale), and `-- --json`/`-- --markdown` for output format.
- An old single-file `data/projects.legacy.json`, if present, is preserved read-only from the pre-migration layout — never edit it.

## Data Model

- **Projects** (`pj_` prefix): named efforts with lifecycle statuses (active/on-hold/completed/archived), optional target date, linked CRM people and businesses, timestamped notes, and resource links.
- Projects cross-link to CRM via `personIds[]` and `businessIds[]`.
- To-dos link to projects via an optional `projectId` field on the todo object.
- **Project tasks** (`pt_` prefix): lightweight checklist items scoped to a single project — things to pick up next time you work on it. Stored in `tasks[]` on the project object. Statuses: `open` / `done`.
- **Project notes** (`pn_` prefix): append-only note objects with stable structured fields: `id`, `createdAt`, `updatedAt`, `text`, and `metadata`. Metadata is intentionally schema-tolerant and should include `schemaVersion`, `title`, `summary`, `kind`, `category`, `tags`, and, where applicable, `canonicalKey`, `current`, `refs[]`, and `relationships[]`. Legacy note fields such as `heading`, `category`, `sourceUrls`, or custom data may remain on the note, but normalize navigational fields into `note.metadata`.

## Commands

All commands output JSON to stdout. Run them from the Brain checkout through `brainctl workspace run`.

### Add a project

```bash
# Quick-add (just a name)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-add.js -- --name "Tax Strategy 2026"

# Full details
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-add.js -- --name "Tax Strategy 2026" --description "Annual tax planning and filing" --status active --target-date "2026-04-15" --person-id ct_abc123 --business-id bz_def456 --notes "Initial setup"
```

### Update a project

```bash
# Update any field(s) — only provided fields change
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-update.js -- --id pj_abc123 --name "New Name" --status on-hold --target-date "2026-06-01"

# Add/remove linked people
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-update.js -- --id pj_abc123 --add-person ct_xxx --remove-person ct_yyy

# Add/remove linked businesses
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-update.js -- --id pj_abc123 --add-business bz_xxx --remove-business bz_yyy

# Archive (soft-delete)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-update.js -- --id pj_abc123 --status archived
```

### List projects

```bash
# All non-archived projects
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-list.js --

# Filter by status
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-list.js -- --status active

# Search by name/description
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-list.js -- --query "tax"

# Include archived
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-list.js -- --all

# Sort by field (name/createdAt/updatedAt/targetDate)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-list.js -- --sort targetDate
```

### View full project detail

```bash
# Shows project + linked people (names from CRM) + linked businesses (names from CRM) + linked todos + notes + resources
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-view.js -- --id pj_abc123
```

### Add a note

```bash
# Metadata is derived when omitted
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-note.js -- --id pj_abc123 --text "Called accountant, confirmed structure"

# Add explicit metadata for navigation/canonical notes
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-note.js -- --id pj_abc123 --text "Conference list source of truth" --title "Conference listings index" --kind canonical-index --category conference-listings --tag conferences --canonical-key decisive-outcomes.conference-listings --current --relationship project:pj_child --ref list:july-conferences-2026
```

### List note metadata only

Use this before opening full project details when navigating notes. It returns note IDs, titles, summaries, tags, canonical keys, refs, and relationships without full `text` bodies.

```bash
# All note summaries/metadata
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-notes-list.js --

# Current/canonical notes only
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-notes-list.js -- --current
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-notes-list.js -- --canonical-key decisive-outcomes.conference-listings

# Scope/filter by project, tag, kind, category, or query
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-notes-list.js -- --id pj_abc123 --tag conferences
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-notes-list.js -- --query "FRSA" --kind research
```

### Remove redundant notes

There is no dedicated project note-delete script. When the user explicitly asks to delete project notes, and the note content has been consolidated into or preserved by another note/resource, it is acceptable to delete the note directly: remove its `.md` file under `workspace/data/projects/<slug>/notes/`, then run `pnpm run brainctl workspace run --path <workspace> project-reindex.js` to rebuild `project.json` and `index.json` from the remaining frontmatter.

Before deleting, identify the exact notes to remove, verify that any unique content is preserved elsewhere or intentionally no longer needed, and keep the replacement/consolidated note intact. After deleting the `.md` file(s) and running `project-reindex.js`, run `project-view.js` for the project to confirm the note is gone and the index is consistent.

### Manage resources

```bash
# Add a resource
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-resource.js -- --id pj_abc123 --add --label "Tax guide" --url "https://example.com/guide"

# Remove by index
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-resource.js -- --id pj_abc123 --remove --index 0

# Remove by label
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-resource.js -- --id pj_abc123 --remove --label "Tax guide"

# List all resources
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-resource.js -- --id pj_abc123 --list
```

### Manage project tasks

```bash
# Add a task
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-task.js -- --id pj_abc123 --add "Define borrower profile for rate analysis"

# List open tasks (default)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-task.js -- --id pj_abc123 --list

# List all tasks including done
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-task.js -- --id pj_abc123 --list --all

# Mark a task done
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-task.js -- --id pj_abc123 --complete pt_xxx

# Reopen a completed task
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-task.js -- --id pj_abc123 --reopen pt_xxx

# Delete a task
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-task.js -- --id pj_abc123 --remove pt_xxx
```

### Delete a project

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" project-delete.js -- --id pj_abc123
```

Prefer `--status archived` via update instead of delete, to preserve history.

### Add a todo linked to a project

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" todo-add.js -- --title "File extension" --project-id pj_abc123
```

### List todos for a project

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" todo-list.js -- --project-id pj_abc123
```

## Interaction Rules

- When adding a project: only name is required (quick-add). Fill in details later.
- When listing: show id, name, status, and target date if set. Do not show internal arrays (notes, resources) in list view — use `project-view.js` for detail.
- When the user mentions a project by name, search first with `--query` to find the right one.
- When orienting to a project with many notes, run `project-notes-list.js` first to load metadata summaries/canonical pointers without full note bodies; then open `project-view.js` or inspect specific note text only when needed.
- When the user asks about a specific project, use `project-view.js` — it gives the full picture including linked CRM entities and todos.
- Suggest linking people/businesses when the user creates a project that clearly involves known contacts.
- Suggest linking todos to projects when the user creates a task that relates to an existing project.
- Prefer `--status archived` over delete for preserving history.
- Notes are normally append-only — use them as a project log. Add a note whenever something significant happens. Every new note must have/use structured metadata; pass explicit title/summary/kind/category/tags/canonical fields when the derived values would be ambiguous. Delete notes only when the user explicitly requests it and the content has been consolidated into or preserved by another note/resource.
- For canonical/index notes, set `metadata.canonicalKey` and `metadata.current: true`, and link child lists/resources/projects/notes through `refs[]` and `relationships[]`.
- Resources are for external links, documents, and references relevant to the project.
- **Project tasks** are lightweight next-actions scoped to a project — not urgent enough for the main todo list. When the user asks "what's next on project X" or "any outstanding tasks on X", show the open project tasks. `project-view.js` includes open tasks automatically.

## Routing

All project operations (add, list, view, update, note, resource, delete) should run directly in the main session — do **not** dispatch a sub-agent. Use **Sonnet medium** effort. Project operations are fast, deterministic, and don't benefit from backgrounding.
