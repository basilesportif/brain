# data boundary

This directory is reserved for generated or user-owned data in local/self-hosted installs. Its contents are ignored by git.

Examples that must stay out of source control: logs, transcripts, generated images/pages, queue state, local databases, and exported personal data.

In a real private Brain workspace, assistant-agent-logic-compatible JSON state
lives under `<workspace>/data/` (`todos.json`, `projects.json`, `crm.json`,
`reminders.json`, and related stores). This repo-level `data/` directory is not
that workspace and should keep only this README.
