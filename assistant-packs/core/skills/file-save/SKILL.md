---
name: file-save
description: Save uploaded files or PDFs into private workspace storage with lightweight metadata, without committing private bytes to source control.
---

# file-save

Use this skill when a user asks to save, keep, file, archive, or attach an uploaded file/PDF/document from the current conversation.

Examples of covered intent:

- "save this PDF"
- "save this"
- "save this to <project>"
- "save this as <title>"
- "attach this to <contact>"

## Boundaries

- Default to private workspace storage, not source control.
- Do not copy private user PDFs or files into the Brain source repo, assistant packs, docs, examples, generated pages, or any public repository.
- Copy the source file; never move or delete the source attachment path as part of a save.
- Save file bytes under a runtime/private directory such as `${BRAIN_PRIVATE_DIR}/documents/files/YYYY/MM/` or `<workspace-root>/private/documents/files/YYYY/MM/`.
- Store metadata under the same private boundary, for example `private/documents/metadata.jsonl`.
- If the destination is inside a git worktree, verify it is ignored before copying. Stop rather than bypassing this check.
- Do not publish, upload, or share the saved file unless the user separately asks for a share/publish action.

## Metadata

Record available lightweight metadata only:

- original filename
- received timestamp
- source entrypoint/chat/message identifiers
- original source attachment path
- saved private path
- optional project label
- optional contact label
- optional generic label
- optional note/title
- optional retention policy
- MIME type, size, and checksum when available

## Workflow

1. Identify the source attachment path from the current inbound event or replied-to event.
2. If the user says "this" and exactly one file is available, use that file. If multiple files are plausible, ask which one.
3. Infer labels conservatively:
   - "to <project>" → project label
   - "attach this to <contact>" → contact label
   - "as <title>" → title
   - retention phrases → retention field
4. Copy the file into private document storage.
5. Append one metadata record with the original source path and copied saved path.
6. Reply with a concise confirmation including the saved path and recorded labels.

## Listing

When the runtime provides a document listing command/tool, use it for requests such as:

- "list saved files"
- "show files for <project>"
- "find the file I saved as <title>"

Only return metadata and private paths by default. Do not expose file bytes or public links unless explicitly requested.
