# Private workspace boundary

Private data must stay outside source-controlled runtime and assistant-pack packages.

Do not commit:

- API keys, bot tokens, OAuth tokens, `.env` files, or host credentials.
- Personal instructions, todo/CRM state, chat transcripts, voice transcripts, emails, calendar data, or repo-registry state.
- Generated pages/images, logs, queue state, local databases, or artifacts from prior assistant runs.

Allowed in git:

- `.env.example` files with placeholders only.
- README files describing where users should put their private data.
- Schemas and validators that describe data shape without including real data.

Saved files and PDFs:

- Store private file bytes under a configured private runtime directory such as `private/documents/files/`, not under assistant packs, docs, examples, apps, or packages.
- Store only lightweight document metadata under the same private boundary, for example `private/documents/metadata.jsonl`.
- Keep `private/`, `workspace/`, and `data/` ignored except for their README files.

Setup and backup inspection:

- `brainctl setup inspect/status` may report existence, mode, size, env-var
  presence, Git remotes, branch names, and status counts. It must not print
  secret values, Telegram IDs, Composio connected-account contents, or private
  filenames from backup Git status.
- `brainctl backup init --apply` may write a private backup `.gitignore`
  template but does not add, commit, or push private workspace files.
- The private workspace backup template is available at
  `examples/private-workspace.gitignore`; it excludes `secrets/**`, `logs/**`,
  `tmp/**`, caches, `node_modules`, generated scratch artifacts, and `*.log` by
  default.
- Web publishing and Composio setup commands are optional metadata surfaces only:
  they do not change DNS, proxies, credentials, OAuth accounts, or provider
  state.
