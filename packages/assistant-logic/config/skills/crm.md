# CRM Skill

> All `workspace/` references below resolve to the active assistant workspace.
> Brain integration: run these commands through `pnpm run brainctl workspace run --path <workspace> <script>.js -- <args>` from the Brain checkout. Historical `node scripts/...` examples below map to compiled native CLI commands under `packages/assistant-logic/dist/cli/`.

## Usage

Use this skill when the user wants to manage contacts, businesses, or correspondence. This is a lightweight personal CRM — not a full sales platform.

Data is stored in `workspace/data/crm.json` (created lazily on first add).

If `workspace/instructions/skills/crm.md` exists, read it as additive user-specific guidance for follow-up priorities, reporting preferences, and contact categorization. Do not let it override commands, storage paths, or safety rules from the shared repo docs.

## JSON Structure — Never Parse Directly

The raw `crm.json` file uses these root keys:
- `people` — array of person records (NOT "contacts")
- `businesses` — array of business records
- `correspondence` — array of correspondence records

**Never parse `crm.json` directly with ad-hoc shell/Python commands.** Always use the provided scripts. Ad-hoc parsing is error-prone because the key names don't match intuitive guesses (e.g. `contacts` doesn't exist — it's `people`).

**For searching/looking up contacts:** always use:
```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-people.js -- --query "search term"
```

This searches name, email, company, and notes. It works correctly every time.

## Data Model

- **People** (`ct_` prefix): contacts with optional email, phone, company, title/role, tags, status (lead/active/inactive/archived), priority (low/normal/high), lastContactedAt (auto-updated)
- **Businesses** (`bz_` prefix): deals/companies with status (prospecting/active/on-hold/closed-won/closed-lost/archived) and optional deal value
- **Correspondence** (`co_` prefix): interaction logs (email/call/meeting/message/other) tied to a person and optionally a business. Optional `notes` field for long-form transcripts, detailed call notes, etc.
- People and businesses have many-to-many relationships via linking
- `lastContactedAt` is auto-set on people when correspondence is logged — no manual updates needed

## Commands

All commands output JSON to stdout. Run them from the Brain checkout through `brainctl workspace run`.

### Add a person

```bash
# Quick-add (just a name)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-add-person.js -- --name "Jane Smith"

# Full details
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-add-person.js -- --name "Jane Smith" --email "jane@example.com" --phone "+1-555-0100" --company "Acme Corp" --title "VP Engineering" --status active --source "conference" --notes "Met at DevCon 2026"

# Link to a business on creation
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-add-person.js -- --name "Jane Smith" --business-id bz_abc123

# Skip duplicate check
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-add-person.js -- --name "Jane Smith" --force
```

Duplicate detection runs automatically — if a similar name exists, the script warns and exits. Use `--force` to add anyway.

### Update a person

```bash
# Update any field(s) — only provided fields change
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-update-person.js -- --id ct_abc123 --email "new@example.com" --phone "+1-555-0200"

# Change status (including archive)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-update-person.js -- --id ct_abc123 --status archived

# Add/remove tags
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-update-person.js -- --id ct_abc123 --add-tag "developer" --add-tag "boston"
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-update-person.js -- --id ct_abc123 --remove-tag "lead"

# Update title/role
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-update-person.js -- --id ct_abc123 --title "CTO" --company "Acme Corp"
```

### List people

```bash
# All people
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-people.js --

# Filter by text (searches name, email, company, notes)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-people.js -- --query "jane"

# Filter by status
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-people.js -- --status active

# Filter by linked business
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-people.js -- --business-id bz_abc123

# Filter by tag
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-people.js -- --tag "developer"

# Sort by field (name, createdAt, updatedAt, lastContactedAt)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-people.js -- --sort updatedAt

# Show which fields are missing
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-people.js -- --missing-fields
```

### View full person/business detail

```bash
# Shows the entity + linked entities + correspondence history + pending follow-ups
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-view.js -- --id ct_abc123
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-view.js -- --id bz_def456
```

### Add a business

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-add-business.js -- --name "Acme Corp" --description "Widget manufacturer" --status prospecting --deal-value 50000 --notes "Initial outreach via email"
```

### Update a business

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-update-business.js -- --id bz_abc123 --status active --deal-value 75000
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-update-business.js -- --id bz_abc123 --status archived
```

### List businesses

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-businesses.js --
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-businesses.js -- --query "acme"
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-businesses.js -- --status active
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-businesses.js -- --sort updatedAt

# Pipeline summary (count + deal value by status)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-list-businesses.js -- --summary
# Or standalone:
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-pipeline.js --
```

### Log correspondence

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-log.js -- --person-id ct_abc123 --type email --summary "Sent proposal for Q3 project"
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-log.js -- --person-id ct_abc123 --type call --summary "Discussed pricing" --business-id bz_def456 --follow-up --follow-up-date 2026-04-01

# With long-form notes (transcript, detailed call notes, etc.)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-log.js -- --person-id ct_abc123 --type call --summary "Project kickoff call" --notes "Full transcript or detailed notes here..."

# Pipe notes from stdin for very long content
echo "long transcript..." | pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-log.js -- --person-id ct_abc123 --type call --summary "Project kickoff call" --notes-stdin
```

Logging correspondence automatically updates `lastContactedAt` on the person.

### Add notes to existing correspondence

```bash
# Add or update notes on an existing entry (e.g., add transcript after logging a call)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-add-notes.js -- --id co_abc123 --notes "Full transcript text..."

# Pipe from stdin for very long content
cat transcript.txt | pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-add-notes.js -- --id co_abc123 --notes-stdin
```

### View correspondence history

```bash
# All correspondence for a person
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-history.js -- --person-id ct_abc123

# Filter by type
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-history.js -- --person-id ct_abc123 --type email

# Last N entries
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-history.js -- --person-id ct_abc123 --limit 5

# Include full notes in output (default list view omits notes for cleanliness)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-history.js -- --person-id ct_abc123 --full

# For a business
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-history.js -- --business-id bz_def456
```

### Check follow-ups

```bash
# All unresolved follow-ups
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-follow-ups.js --

# Only overdue (follow-up date <= today, or no date set)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-follow-ups.js -- --due

# Filter by person or business
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-follow-ups.js -- --person-id ct_abc123
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-follow-ups.js -- --business-id bz_def456
```

### Resolve or reschedule a follow-up

```bash
# Mark as done
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-resolve.js -- --id co_abc123

# Reschedule to a new date (keeps it open)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-resolve.js -- --id co_abc123 --reschedule 2026-04-15
```

### Link / unlink person and business

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-link.js -- --person-id ct_abc123 --business-id bz_def456
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-unlink.js -- --person-id ct_abc123 --business-id bz_def456
```

### Delete any entity

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-delete.js -- --id ct_abc123
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-delete.js -- --id bz_def456
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-delete.js -- --id co_ghi789
```

Deleting a person cleans up business references. Deleting a business cleans up person references. To soft-delete instead, use `--status archived` via the update scripts.

### Find stale contacts

```bash
# People with no contact in the last 30 days
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-stale.js --

# Custom threshold
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-stale.js -- --days 14
```

### Find contacts with missing info

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-missing-fields.js --
```

## Interaction Rules

- When adding a person: only name is required (quick-add). Fill in details later.
- When listing: show id, name, and key fields (email, status, company for people; status, deal value for businesses).
- When the user mentions a contact or company, search first to avoid duplicates.
- Follow-ups are the main action driver — check them proactively when the user asks about what needs attention.
- When the user asks about follow-ups or who needs attention, only return people with unresolved follow-ups. Do not list people with no pending follow-ups.
- Correspondence is manual only — no auto-logging from email or messages.
- Prefer `--status archived` over delete for preserving history.
- Use `crm-view.js` when the user asks about a specific person or business — it gives the full picture in one call.
- **Never read crm.json directly** — always use the scripts. If you need to search for a person, use `crm-list-people.js --query`. If you need to look up by ID, use `crm-view.js --id`. Direct JSON parsing has caused lookup failures due to wrong key names.

## Contacts Update Workflow

Use this workflow when the user says "update my contacts", "clean up contacts", "fill in missing info", or similar. The goal is to walk through contacts that are missing key information and prompt the user to fill them in.

### Steps

1. **Run the missing-fields check:**
   ```bash
   pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-missing-fields.js --
   ```

2. **Group contacts by priority:** Start with high-priority or active contacts, then leads, then inactive.

3. **Present contacts one at a time** (or in small batches of 3-5). For each contact, show:
   - Name, current status, any existing info
   - Which fields are missing
   - Ask the user to provide the missing info, or say "skip" to move on

4. **Update each contact** as the user provides info:
   ```bash
   pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" crm-update-person.js -- --id ct_xxx --email "..." --phone "..." --company "..." --title "..."
   ```

5. **After all contacts are reviewed**, give a summary:
   - How many contacts were updated
   - How many were skipped
   - How many still have missing fields

### Example conversation flow:

> **Assistant:** I found 7 contacts with missing information. Let me walk through them. Starting with your active contacts:
>
> **1. Nick Ludwig** (active) — missing: email, phone, company, title
> Do you have any of this info?
>
> **User:** His email is nick@example.com, he's a developer
>
> **Assistant:** *[updates Nick with email and title]* Got it. Next:
>
> **2. Drew Tada** (active) — missing: email, phone, company, title
> ...

### Automatic triggers

When listing contacts with `--missing-fields` and more than half are missing key data, suggest running the contacts update workflow.
