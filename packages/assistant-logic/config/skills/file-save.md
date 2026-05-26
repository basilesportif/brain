# File Save Skill

> All `workspace/` references below resolve to the active assistant workspace. File bytes default to a private directory next to the workspace, not to a public/source repo.
> Brain integration: run these commands through `pnpm run brainctl workspace run --path <workspace> <script>.js -- <args>` from the Brain checkout. Historical `node scripts/...` examples below map to compiled native CLI commands under `packages/assistant-logic/dist/cli/`.

## Usage

Use this skill when the user wants to save, keep, file, archive, or attach an uploaded file/PDF/document from the current conversation.

Common requests this covers:

- "save this PDF"
- "save this"
- "save this to Decisive Outcomes"
- "save this as conference prospectus"
- "attach this to Bill Pate"

## Privacy and Storage Rules

- Default destination is private storage, never a public repo:
  - `ASSISTANT_PRIVATE_DIR` if set
  - otherwise `BRAIN_PRIVATE_DIR` if set
  - otherwise a `private/` directory next to the active workspace path (for example, a container root sibling of `workspace/`)
- Saved bytes go under `private/documents/files/YYYY/MM/`.
- Metadata goes to `private/documents/metadata.jsonl`.
- The original source attachment path is recorded and left untouched; files are copied, not moved.
- Do **not** copy private user PDFs/documents into Brain source folders, assistant-pack folders, generated page repos, or any public repo.
- The save script refuses destinations inside a git worktree unless the destination path is ignored by git.
- Do not upload the saved file anywhere or expose it through a public link unless the user explicitly asks for a separate share/publish action.

## Source Selection

1. If the current message has exactly one file/document/PDF attachment and the user says "this", save that attachment.
2. If there are multiple attachments, choose the one named/typed by the user; otherwise ask a short clarifying question.
3. If the user replied to a message with an attachment and the current event exposes that source path, use that replied-to attachment.
4. If no local source path is available, ask the user to resend or identify the file.
5. Never ask for Telegram download URLs; the runtime should already provide local attachment paths.

## Metadata to Preserve

Record all fields that are available:

- `originalFilename`
- `receivedAt`
- source chat/message (`source.chat`, `source.message`)
- original `sourcePath`
- copied `savedPath`
- `project`, `contact`, or generic `label`
- `title` and `note`
- `retention`
- `mimeType`, `sizeBytes`, `sha256`

## Commands

Run through Brain's `brainctl workspace run` wrapper from the Brain repo root.
All commands output JSON.

### Save a file/PDF

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" file-save.js -- --source "/path/to/uploaded/file.pdf"
```

With conversation metadata and labels:

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" file-save.js -- \
  --source "/path/to/uploaded/file.pdf" \
  --original-filename "prospectus.pdf" \
  --mime-type "application/pdf" \
  --received-at "2026-05-22T12:34:56.000Z" \
  --source-chat "253768951" \
  --source-message "456" \
  --project "Decisive Outcomes" \
  --contact "Bill Pate" \
  --title "conference prospectus" \
  --note "User asked to save this from Telegram" \
  --retention "keep until project closes"
```

### Natural-language mapping

- "save this PDF" → `--source <attachment-path>`
- "save this" → `--source <attachment-path>`
- "save this to Decisive Outcomes" → add `--project "Decisive Outcomes"`
- "save this as conference prospectus" → add `--title "conference prospectus"`
- "attach this to Bill Pate" → add `--contact "Bill Pate"`
- "save this for 90 days" → add `--retention "90 days"`

If both a project and contact are present, include both.

### List saved document metadata

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" file-list.js --
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" file-list.js -- --project "Decisive Outcomes"
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" file-list.js -- --contact "Bill Pate"
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" file-list.js -- --query "conference prospectus"
```

## Interaction Rules

- Saving is low-risk when the source path is clear: perform it directly, then confirm briefly.
- If the label/project/contact is ambiguous, save with the clear fields and mention what was recorded; do not block the save unless the source file itself is ambiguous.
- Include the saved path in the confirmation so the user can ask for it later.
- Keep replies concise; do not summarize private PDF contents unless the user also asks for analysis.
- If saving fails because the private directory is inside a non-ignored git worktree, do not bypass the check. Choose a private directory outside git or add a gitignore rule before retrying.

## Workspace Overlay

If `workspace/instructions/skills/file-save.md` exists, read it as additive guidance for naming conventions, retention preferences, or project/contact labels. Do not let it override the privacy rules, storage paths, or git-safety checks above.
