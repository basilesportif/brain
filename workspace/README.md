# workspace boundary

This directory marks where a self-hosted user workspace may be mounted or symlinked in future designs. Its contents are ignored by git.

Do not commit user instructions, credentials, personal state, chat transcripts, generated pages, or repo-registry state here.

The setup flow creates private project memory paths in the configured workspace:

- `projects/`
- `notes/`
- `documents/`
- `documents/metadata/`

Commit non-secret project memory only to the user's private workspace backup repo, not this public source checkout.
