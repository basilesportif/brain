// Shared, conservative token redaction for admin responses and audit summaries.
// Callers may still apply shorter output caps after this pass.

export function redactSecretText(text: string): string {
  return text
    // Slack bot/user/app/refresh/session tokens and app-level xapp tokens.
    .replace(/\bxox[baprsed]-[A-Za-z0-9-]+/gi, "[redacted-slack-token]")
    .replace(/\bxapp-[A-Za-z0-9-]+/gi, "[redacted-slack-token]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[redacted-openai-key]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted-github-token]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/v0=[a-f0-9]{32,}/gi, "v0=[redacted-signature]");
}
