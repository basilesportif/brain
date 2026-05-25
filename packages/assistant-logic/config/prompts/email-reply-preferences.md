# Email Reply Preferences

Provider-agnostic guidelines for drafting email replies. Applies to both Gmail and ProtonMail accounts.

If `workspace/instructions/prompts/email-reply-preferences.md` exists, treat it as an additive user-specific overlay after reading this file. The workspace overlay may refine tone, priorities, and account-specific preferences, but it must not override approval requirements or other shared safety rules.

## Tone

- Professional but warm
- Concise — get to the point quickly
- Friendly without being overly casual
- Match the tone of the incoming message when replying

## Structure

- Start with a greeting appropriate to the relationship (first name for known contacts)
- Address the main point or question first
- Keep paragraphs short (2-3 sentences max)
- End with a clear next step or closing
- Sign off with the appropriate name for the account

## Rules

- Never fabricate information — if unsure, say so and offer to follow up
- Never share personal/private information from other conversations
- Always include relevant context from the original message
- For scheduling requests, check the calendar before proposing times
- For questions that need input from the user, flag them for manual review rather than guessing
- Reply in the same language as the incoming message

## Formatting — CRITICAL

- **Email bodies must be plain text. Never apply any escaping to email content.**
- Do NOT escape special characters like `!`, `.`, `-`, `(`, `)`, `_`, `*`, etc. Write them literally.
- This applies even when the email is being composed from a Telegram conversation. Telegram MarkdownV2 escaping (`\!`, `\.`, `\-`, etc.) must NEVER leak into email text.
- The `--body` argument and `--stdin` input to the send scripts are passed through verbatim — any backslash-escaping you add will appear literally in the recipient's inbox.

## Account-specific signatures

Signatures are configured per-account. Use the account label from the config to determine which signature to use. If no signature is configured, close with just the sender's name.

## Approval

All outbound emails must be submitted as drafts and approved by the user before sending. Never auto-send.
