#!/usr/bin/env node
/**
 * Dispatch a Claude sub-agent via @anthropic-ai/claude-agent-sdk with a
 * specified effort level.
 *
 * Flags:
 *   --prompt "TEXT"    prompt for the sub-agent. If omitted, prompt is read
 *                      from stdin.
 *   --model ID         model id (default: claude-sonnet-4-6)
 *   --effort LEVEL     effort level: low|medium|high|xhigh|max
 *                      (default: medium)
 *
 * Auth: uses the Max subscription credentials in ~/.claude/.credentials.json.
 * ANTHROPIC_API_KEY must NOT be set in the environment or the SDK will try to
 * use it instead.
 *
 * Output: prints the `result` text from the SDKResultSuccess message to stdout
 * on success. On any error message or thrown error, writes to stderr and
 * exits with code 1.
 */
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const MODEL_ALIASES = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

function resolveModel(input) {
  return MODEL_ALIASES[input.toLowerCase()] ?? input;
}

function parseArgs(argv) {
  const args = {
    prompt: null,
    model: "claude-sonnet-4-6",
    effort: "medium",
  };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--prompt" && argv[i + 1] !== undefined) {
      args.prompt = argv[++i];
      i++;
    } else if (arg === "--model" && argv[i + 1] !== undefined) {
      args.model = resolveModel(argv[++i]);
      i++;
    } else if (arg === "--effort" && argv[i + 1] !== undefined) {
      args.effort = argv[++i];
      i++;
    } else {
      i++;
    }
  }
  return args;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (!VALID_EFFORTS.has(args.effort)) {
    console.error(
      `Invalid --effort "${args.effort}". Must be one of: ${Array.from(
        VALID_EFFORTS
      ).join(", ")}`
    );
    process.exit(1);
  }

  let prompt = args.prompt;
  if (!prompt) {
    prompt = (await readStdin()).trim();
  }
  if (!prompt) {
    console.error(
      'Usage: dispatch-claude-sdk.mjs --prompt "TEXT" [--model ID] [--effort LEVEL]'
    );
    console.error("  or pipe the prompt via stdin.");
    process.exit(1);
  }

  // Isolate from the parent session's Claude config so the child CLI doesn't
  // load the Telegram plugin (or any other) and SIGTERM the parent's poller
  // via the plugin's stale-PID killer. The SDK/CLI resolves plugin + settings
  // paths off CLAUDE_CONFIG_DIR, so pointing it at a clean empty dir
  // disables plugin loading in the child. Credentials still live at
  // ~/.claude/.credentials.json — symlink them in so auth keeps working.
  const isolatedConfigDir = mkdtempSync(path.join(tmpdir(), "claude-sdk-cfg-"));
  const realCreds = path.join(process.env.HOME, ".claude", ".credentials.json");
  try {
    symlinkSync(realCreds, path.join(isolatedConfigDir, ".credentials.json"));
  } catch {}
  process.env.CLAUDE_CONFIG_DIR = isolatedConfigDir;

  const options = {
    model: args.model,
    effort: args.effort,
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    // Belt-and-suspenders: make isolation explicit so future SDK default
    // changes can't reintroduce the plugin/MCP conflict.
    settingSources: [],
    mcpServers: {},
    plugins: [],
  };

  for await (const message of query({ prompt, options })) {
    if (message.type === "result" && message.subtype === "success") {
      process.stdout.write(message.result ?? "");
      if (!String(message.result ?? "").endsWith("\n")) {
        process.stdout.write("\n");
      }
      return;
    }
    if (message.type === "result") {
      const errText =
        (Array.isArray(message.errors) && message.errors.join("\n")) ||
        message.subtype ||
        "Unknown error";
      process.stderr.write(`${errText}\n`);
      process.exit(1);
    }
  }

  // Iterator ended without a result message
  process.stderr.write("No result message received from Claude Agent SDK\n");
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
