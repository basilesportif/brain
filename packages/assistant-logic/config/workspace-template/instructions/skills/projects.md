# Workspace Overlay: Projects

Add only user-specific preferences here. This file is layered on top of `config/skills/projects.md`.

## Storage preference

- Project notes are stored as markdown files under `workspace/data/projects/<slug>/notes/` — the `.md` file is the source of truth; `index.json` and `project.json` are a maintained, rebuildable projection.
- Direct edits to a note's `.md` file (body or frontmatter) are allowed when needed, but must be followed by `pnpm run brainctl workspace run --path <workspace> project-reindex.js` so the JSON index stays in sync.

## Priority Preferences

- Projects that should always surface in status reviews:
- How to weight target dates vs. status when prioritizing:

## Reporting Preferences

- How verbose project summaries should be:
- Whether to include linked CRM details in casual reports:
- Any project statuses or tags that deserve special attention:

## Project Note Metadata Preferences

- Before opening full project notes, prefer the metadata-only note index (`project-notes-list.js`) to identify relevant summaries, canonical keys, refs, and relationships.
- When creating notes, ensure each note has useful metadata: title, summary, kind/category, tags, and canonical/current markers plus refs/relationships when the note is an index or source of truth.
- Keep canonical project indexes explicit with stable `metadata.canonicalKey` values so future agents know where to look first.

## Notes

- Keep this file additive. Do not restate shared commands or safety rules.
