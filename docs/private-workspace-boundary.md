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
