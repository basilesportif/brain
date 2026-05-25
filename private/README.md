# private boundary

This directory is reserved for private local-only material during development. Its contents are ignored by git.

Do not use it as a source for public migration unless a cleanup/audit phase explicitly approves each file.

In a real private workspace, file-save metadata/bytes live under
`<workspace>/private/documents/` when `BRAIN_PRIVATE_DIR=<workspace>/private`
is used. This repo-level placeholder must not contain user documents.
