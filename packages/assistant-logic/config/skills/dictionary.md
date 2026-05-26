# Dictionary Skill

> All `workspace/` references resolve to the active assistant workspace.

## Usage

Use this skill when the user wants to create, update, inspect, or deploy a dictionary for voice/audio transcription.

A dictionary is stored as a Projects entry. It usually contains:

- The reusable transcription prompt as a project note whose first line starts with `Transcription prompt:`.
- Dictionary entries as bullet lines in normal project notes.
- A deployment file path as a project resource labelled `Dictionary deployment target`, unless `DICTIONARY_TARGET_PATH` is set.

Workspace-specific defaults belong in `workspace/.env` or `workspace/instructions/skills/dictionary.md`:

```dotenv
DICTIONARY_PROJECT_ID=pj_...
DICTIONARY_TARGET_PATH=/absolute/path/to/voice-transcription.md
```

For legacy compatibility, `node scripts/dictionary-deploy.js` still defaults to the unique project named `Dictionary` when no project id is configured.

## Commands

All scripts output JSON to stdout. Run from the `assistant-agent-logic` repo root unless noted.

### View the dictionary project

```bash
node scripts/project-view.js --id pj_...
```

### Add dictionary entries

Append entries as a note. Keep each dictionary item on its own bullet line. Use replacements as plain text, for example `wrong -> Right`.

```bash
node scripts/project-note.js --id pj_... --text "Dictionary additions:
- New Term
- misheard term -> Preferred Term"
```

### Update the reusable prompt

Add a new prompt note. The newest note starting with `Transcription prompt:` wins on deploy.

```bash
node scripts/project-note.js --id pj_... --text "Transcription prompt:
Use this as transcription vocabulary and correction guidance. Preserve the speaker's meaning. Prefer the spellings and replacements below when audio is ambiguous. Remove filler words.

USER DICTIONARY:"
```

### Store or update the deployment target

The target path can live in `DICTIONARY_TARGET_PATH` or in the project as a resource.

```bash
node scripts/project-resource.js --id pj_... --add --label "Dictionary deployment target" --url "/absolute/path/to/voice-transcription.md"
```

If the target changes, remove the old resource by label or index, then add the new one.

### Deploy

```bash
node scripts/dictionary-deploy.js
```

Dry-run without writing:

```bash
node scripts/dictionary-deploy.js --dry-run --print
```

Deployment concatenates the newest prompt note with all unique bullet entries from non-prompt notes, preserving first-seen entry order, then writes the result to the configured target path.

## Creating Another Dictionary Project

1. Create a project:

```bash
node scripts/project-add.js --name "Dictionary" --description "Collect dictionary words and preferred spellings for transcription cleanup."
```

2. Add a `Transcription prompt:` note.
3. Add `DICTIONARY_PROJECT_ID` and `DICTIONARY_TARGET_PATH` to workspace config, or add a `Dictionary deployment target` resource with an absolute path.
4. Add entries as bullet notes.
5. Run `node scripts/dictionary-deploy.js`.

Use `--project-name "Dictionary"` only when the name is unique. Prefer `--project-id` or `DICTIONARY_PROJECT_ID` for durable automation.

## Interaction Rules

- After adding entries or changing the prompt, deploy immediately unless the user explicitly asks only to record the notes.
- Keep secrets out of dictionary entries and prompt text. The deployed file may be sent to a transcription model with each audio request.
- Do not edit app-specific transcription config for normal dictionary updates; update the project resource or workspace env and redeploy instead.
- Do not hand-edit the deployed file as the source of truth. If a direct edit is unavoidable, copy the change back into the Dictionary project before the next deploy.
