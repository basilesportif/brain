#!/usr/bin/env node
/**
 * Send a new Gmail message or reply to a thread.
 *
 * Usage:
 *   # Send new email
 *   node scripts/gmail-send.js --to "user@example.com" --subject "Hello" --body "Message text" --account user@example.com
 *
 *   # Reply to a thread
 *   node scripts/gmail-send.js --thread-id <threadId> --to "user@example.com" --subject "Re: Hello" --body "Reply text" --account user@example.com
 *
 *   # Reply with In-Reply-To header (for proper threading)
 *   node scripts/gmail-send.js --thread-id <threadId> --message-id "<msg-id@mail.gmail.com>" --to "user@example.com" --subject "Re: Hello" --body "Reply text"
 *
 *   # Read body from stdin
 *   echo "Long message" | node scripts/gmail-send.js --to "user@example.com" --subject "Hello" --stdin
 *
 *   # CC recipients
 *   node scripts/gmail-send.js --to "user@example.com" --cc "other@example.com,third@example.com" --subject "Hello" --body "Hi"
 *
 * Output: JSON object with sent message id and threadId.
 */
const {
  loadComposioConfig,
  requireGmailAccounts,
} = require("./lib/config");
const { getAccessToken, googleFetch } = require("./lib/google-auth");

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--to" && argv[i + 1]) {
      args.to = argv[++i];
    } else if (arg === "--cc" && argv[i + 1]) {
      args.cc = argv[++i];
    } else if (arg === "--subject" && argv[i + 1]) {
      args.subject = argv[++i];
    } else if (arg === "--body" && argv[i + 1]) {
      args.body = argv[++i];
    } else if (arg === "--account" && argv[i + 1]) {
      args.account = argv[++i];
    } else if (arg === "--thread-id" && argv[i + 1]) {
      args.threadId = argv[++i];
    } else if (arg === "--message-id" && argv[i + 1]) {
      args.messageId = argv[++i];
    } else if (arg === "--stdin") {
      args.stdin = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printUsage() {
  console.error(`Usage: node scripts/gmail-send.js [options]

Required:
  --to <email>          Recipient email address
  --subject <text>      Email subject line
  --body <text>         Message body (plain text)
  --stdin               Read body from stdin instead of --body

Optional:
  --cc <emails>         CC recipients (comma-separated)
  --account <email>     Send from this account (matches email in composio.yaml)
  --thread-id <id>      Thread ID for replies (keeps message in same thread)
  --message-id <id>     Message-ID header of email being replied to (for In-Reply-To)
  --help                Show this help message

Examples:
  node scripts/gmail-send.js --to "user@example.com" --subject "Hello" --body "Hi there"
  node scripts/gmail-send.js --thread-id abc123 --to "user@example.com" --subject "Re: Hello" --body "Thanks"
  echo "Long email body" | node scripts/gmail-send.js --to "user@example.com" --subject "Hello" --stdin`);
}

/**
 * Resolve account email to Composio connected account ID.
 * If no account specified, returns the first Gmail account.
 */
function resolveAccountId(accountEmail, composio) {
  const gmailAccounts = requireGmailAccounts(composio);
  if (!accountEmail) {
    return gmailAccounts[0];
  }
  const email = accountEmail.toLowerCase();
  for (const entry of gmailAccounts) {
    const label = (composio.ACCOUNT_LABELS[entry] || "").toLowerCase();
    if (label === email || entry.toLowerCase() === email) {
      return entry;
    }
  }
  throw new Error(
    `No Gmail account found for "${accountEmail}". Available: ${gmailAccounts.map((id) => composio.ACCOUNT_LABELS[id] || id).join(", ")}`
  );
}

/**
 * Build RFC 2822 formatted email message.
 */
function buildRfc2822(opts) {
  const lines = [];
  lines.push(`To: ${opts.to}`);
  if (opts.cc) {
    lines.push(`Cc: ${opts.cc}`);
  }
  if (opts.from) {
    lines.push(`From: ${opts.from}`);
  }
  lines.push(`Subject: ${opts.subject}`);
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("MIME-Version: 1.0");

  // Threading headers for replies
  if (opts.messageId) {
    lines.push(`In-Reply-To: ${opts.messageId}`);
    lines.push(`References: ${opts.messageId}`);
  }

  lines.push(""); // blank line separates headers from body
  lines.push(opts.body);

  return lines.join("\r\n");
}

/**
 * Base64url encode a string (no padding).
 */
function base64urlEncode(str) {
  return Buffer.from(str, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
    // Timeout after 5 seconds in case nothing is piped
    setTimeout(() => {
      if (!data) reject(new Error("No input received on stdin after 5s"));
    }, 5000);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const composio = loadComposioConfig();

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  // Validate required args
  if (!args.to) {
    console.error("Error: --to is required");
    printUsage();
    process.exit(1);
  }
  if (!args.subject) {
    console.error("Error: --subject is required");
    printUsage();
    process.exit(1);
  }

  // Get body from --body or --stdin
  let body;
  if (args.stdin) {
    body = await readStdin();
  } else if (args.body) {
    body = args.body;
  } else {
    console.error("Error: --body or --stdin is required");
    printUsage();
    process.exit(1);
  }

  // Resolve account
  const accountId = resolveAccountId(args.account, composio);
  const fromEmail = composio.ACCOUNT_LABELS[accountId] || accountId;
  const token = await getAccessToken(accountId, { composio });

  // Build the message
  const raw = buildRfc2822({
    to: args.to,
    cc: args.cc || null,
    from: fromEmail,
    subject: args.subject,
    body,
    messageId: args.messageId || null,
  });

  const encoded = base64urlEncode(raw);

  // Build request payload
  const payload = { raw: encoded };
  if (args.threadId) {
    payload.threadId = args.threadId;
  }

  // Send via Gmail API
  const result = await googleFetch(
    token,
    `${GMAIL_BASE}/users/me/messages/send`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        id: result.id,
        threadId: result.threadId,
        labelIds: result.labelIds,
        from: fromEmail,
        to: args.to,
        subject: args.subject,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
