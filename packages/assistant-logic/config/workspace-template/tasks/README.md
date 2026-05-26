# Scheduled Tasks

Scheduled tasks must target both this repo clone and this workspace explicitly.

Preferred command shape:

```bash
cd /abs/path/to/assistant-agent-logic && ASSISTANT_WORKSPACE=/abs/path/to/workspace <task command>
```

Examples:

```bash
cd /abs/path/to/assistant-agent-logic && ASSISTANT_WORKSPACE=/abs/path/to/workspace node scripts/messages-unread.js
cd /abs/path/to/assistant-agent-logic && ASSISTANT_WORKSPACE=/abs/path/to/workspace node scripts/gmail-actionable.js
```

Do not install task commands that omit `ASSISTANT_WORKSPACE=<path>`.
