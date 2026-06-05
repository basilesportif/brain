# Workspace Instruction Overlays

These files are the workspace-owned layer for user-specific preferences.

Use them to refine:

- what kinds of emails or messages deserve notification
- which senders, topics, or calendars are high or low priority
- drafting tone, signatures, and account-specific style notes
- other personal preferences that should not live in the shared repo

Do not use them to redefine:

- commands or script entrypoints
- storage paths or file formats
- approval requirements
- safety rules

Mapping:

- `instructions/skills/composio.md` overlays `config/skills/composio.md`
- `instructions/skills/messaging.md` overlays `config/skills/messaging.md`
- `instructions/skills/protonmail.md` overlays `config/skills/protonmail.md`
- `instructions/skills/finance.md` overlays `config/skills/finance.md`
- `instructions/skills/calendar-allowlist.md` overlays `config/skills/calendar-allowlist.md`
- `instructions/skills/crm.md` overlays `config/skills/crm.md`
- `instructions/skills/conference-lists.md` overlays `config/skills/conference-lists.md`
- `instructions/skills/betting.md` overlays `config/skills/betting.md`
- `instructions/skills/dictionary.md` overlays `config/skills/dictionary.md`
- `instructions/skills/projects.md` overlays `config/skills/projects.md`
- `instructions/skills/file-save.md` overlays `config/skills/file-save.md`
- `instructions/skills/repo-registry.md` overlays `config/skills/repo-registry/SKILL.md`
- `instructions/prompts/bet-entry-preferences.md` overlays `config/prompts/bet-entry-preferences.md`
- `instructions/prompts/email-reply-preferences.md` overlays `config/prompts/email-reply-preferences.md`

These files are optional. If a file is missing, the shared repo guidance applies on its own.
